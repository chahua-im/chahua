import { createEnvironmentInjector, EnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { PinResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { Connection } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireMessage } from '../api/testing';
import type { ChatPins } from '../chats/chat-pins';
import { ChatStore } from '../chats/chat-store';
import { SessionStore } from '../session/session-store';
import { MessageActions } from './message-actions';

const currentUser = { ...testUser, avatarUrl: 'https://example.com/me.jpg' };
const ownReactor = { uid: currentUser.uid, name: currentUser.username, avatarUrl: currentUser.avatarUrl };
const pin: PinResponse = {
  id: encodeId('9007199254741010'),
  chatId: testChat.id,
  message: testMessage,
  pinnedBy: testUser.uid,
  pinnedAt: testMessage.createdAt,
};
const wirePin = { ...pin, id: decodeId(pin.id), chatId: decodeId(pin.chatId), message: wireMessage };

const messageParams = { chatId: decodeId(testChat.id), messageId: decodeId(testMessage.id) };

describe('MessageActions', () => {
  let actions: MessageActions;
  let conversation: ChatPins;
  let peer: RpcTestPeer;
  let scope: EnvironmentInjector;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<void>;

  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        ...provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: SessionStore, useValue: { user: signal(currentUser) } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    scope = createEnvironmentInjector([ChatStore, MessageActions], TestBed.inject(EnvironmentInjector));
    actions = scope.get(MessageActions);
    conversation = scope.get(ChatStore).pins(testChat.id);
  });

  afterEach(() => {
    scope.destroy();
    peer.verify();
  });

  async function loadPins(pins: (typeof wirePin)[] = []) {
    const loading = conversation.ensure();
    peer.expect('pins.list', { chatId: decodeId(testChat.id) }).flush({ pins: structuredClone(pins) });
    await loading;
  }

  it('recalls the selected message using its original IDs', async () => {
    await loadPins([wirePin]);
    const recalled = actions.recall(testMessage);
    peer.expect('messages.delete', messageParams).flush(null);
    await recalled;
    expect(conversation.get(testMessage.id)?.message).toMatchObject({
      isDeleted: true,
      attachments: [],
      reactions: [],
    });
  });

  it.each(['👍', '#️⃣'])(
    'shows the current user avatar immediately for %s and removes the last reaction',
    async (emoji) => {
      await loadPins([wirePin]);
      const adding = actions.toggleReaction(testMessage, emoji);
      expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
        { emoji, count: 1, reactedByMe: true, reactors: [ownReactor] },
      ]);
      peer.expect('reactions.add', { ...messageParams, emoji }).flush(null);
      await adding;

      const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, emoji);
      expect(conversation.get(testMessage.id)?.message.reactions).toEqual([]);
      peer.expect('reactions.remove', { ...messageParams, emoji }).flush(null);
      await removing;
    },
  );

  it('uses the latest profile and removes only the current user from an existing reaction', async () => {
    const other = { uid: 2, name: '朋友', avatarUrl: 'https://example.com/friend.jpg' };
    await loadPins([
      { ...wirePin, message: { ...wireMessage, reactions: [{ emoji: '👍', count: 1, reactors: [other] }] } },
    ]);
    const latest = { ...currentUser, username: '新的名字', avatarUrl: 'https://example.com/new.jpg' };
    TestBed.inject(SessionStore).user.set(latest);
    const original = conversation.get(testMessage.id)!.message;
    const adding = actions.toggleReaction(original, '👍');
    expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reactedByMe: true,
        reactors: [other, { uid: latest.uid, name: latest.username, avatarUrl: latest.avatarUrl }],
      },
    ]);
    expect(original.reactions[0].reactors).toEqual([other]);
    peer.expect('reactions.add', { ...messageParams, emoji: '👍' }).flush(null);
    await adding;

    const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, '👍');
    expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
      { emoji: '👍', count: 1, reactedByMe: false, reactors: [other] },
    ]);
    peer.expect('reactions.remove', { ...messageParams, emoji: '👍' }).flush(null);
    await removing;
    peer.expectNone('reactions.add');
    peer.expectNone('reactions.remove');
  });

  it('keeps WebSocket totals and personal selections when the mutation finishes later', async () => {
    await loadPins([wirePin]);
    const adding = actions.toggleReaction(testMessage, '👍');
    const mutation = peer.expect('reactions.add', { ...messageParams, emoji: '👍' });
    const serverReactors = [ownReactor, { uid: 2, name: '另一位用户' }];
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: testChat.id,
        messageId: testMessage.id,
        reactions: [{ emoji: '👍', count: 4, reactors: serverReactors }],
      },
    });
    mutation.flush(null);
    await adding;
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({ count: 4, reactedByMe: true });

    const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, '👍');
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({ count: 3, reactedByMe: false });
    peer.expect('reactions.remove', { ...messageParams, emoji: '👍' }).flush(null);
    await removing;
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [{ emoji: '👍', count: 5 }] },
    });
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({ count: 5, reactedByMe: false });
  });

  it('propagates mutation failure and reverts the optimistic reaction', async () => {
    await loadPins([wirePin]);
    const adding = actions.toggleReaction(testMessage, '👍');
    const failure = expect(adding).rejects.toBeDefined();
    peer.expect('reactions.add', { ...messageParams, emoji: '👍' }).error(RpcErrorCode.Forbidden);
    await failure;
    expect(conversation.get(testMessage.id)?.message.reactions).toEqual([]);
  });
});
