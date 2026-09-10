import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { PinResponse, ServerWsMessage } from '../../generated/models';
import { ServerWsMessageType } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireMessage } from '../api/testing';
import type { ChatPins } from '../chats/chat-pins';
import { ChatStore } from '../chats/chat-store';
import { MessageActions } from './message-actions';
import { SessionStore } from '../session/session-store';

const currentUser = { ...testUser, avatarUrl: 'https://example.com/me.jpg' };
const ownReactor = { uid: currentUser.uid, name: currentUser.username, avatarUrl: currentUser.avatarUrl };

const chatUrl = `/_api/chats/${decodeId(testChat.id)}`;
const messageUrl = `${chatUrl}/messages/${decodeId(testMessage.id)}`;
const pin: PinResponse = {
  id: encodeId('9007199254741010'),
  chatId: testChat.id,
  message: testMessage,
  pinnedBy: testUser.uid,
  pinnedAt: testMessage.createdAt,
};
const wirePin = { ...pin, id: decodeId(pin.id), chatId: decodeId(pin.chatId), message: wireMessage };

describe('MessageActions', () => {
  let actions: MessageActions;

  let conversation: ChatPins;

  let http: HttpTestingController;

  let scope: EnvironmentInjector;

  let events: Subject<ServerWsMessage>;

  let resync: Subject<void>;

  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: SessionStore, useValue: { user: signal(currentUser) } },
      ],
    });
    scope = createEnvironmentInjector([ChatStore, MessageActions], TestBed.inject(EnvironmentInjector));
    actions = scope.get(MessageActions);
    conversation = scope.get(ChatStore).pins(testChat.id);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    scope.destroy();
    http.verify();
  });

  async function loadPins(pins: (typeof wirePin)[] = []) {
    const loading = conversation.ensure();
    http.expectOne(`${chatUrl}/pins`).flush({ pins: structuredClone(pins) });
    await loading;
  }

  it('saves and recalls the selected message using its original IDs', async () => {
    await loadPins([wirePin]);
    const saved = actions.save(testMessage);
    const save = http.expectOne(`/_api/saved-messages/${decodeId(testMessage.id)}`);
    expect(save.request.method).toBe('PUT');
    save.flush({});
    await saved;
    const recalled = actions.recall(testMessage);
    const recall = http.expectOne(messageUrl);
    expect(recall.request.method).toBe('DELETE');
    recall.flush(null);
    await recalled;
    expect(conversation.get(testMessage.id)?.message).toMatchObject({
      isDeleted: true,
      attachments: [],
      reactions: [],
    });
  });

  it.each(['👍', '#️⃣'])(
    'shows the current user avatar immediately for %s and removes the last reaction without reading details',
    async (emoji) => {
      await loadPins([wirePin]);
      const adding = actions.toggleReaction(testMessage, emoji);
      expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
        { emoji, count: 1, reactedByMe: true, reactors: [ownReactor] },
      ]);
      const put = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent(emoji)}`);
      expect(put.request.method).toBe('PUT');
      put.flush(null);
      await adding;

      const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, emoji);
      expect(conversation.get(testMessage.id)?.message.reactions).toEqual([]);
      const deletion = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent(emoji)}`);
      expect(deletion.request.method).toBe('DELETE');
      deletion.flush(null);
      await removing;
      http.expectNone(() => true);
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
    http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`).flush(null);
    await adding;

    const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, '👍');
    expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
      { emoji: '👍', count: 1, reactedByMe: false, reactors: [other] },
    ]);
    http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`).flush(null);
    await removing;
    http.expectNone(() => true);
  });

  it('keeps WebSocket totals and personal selections when the mutation finishes later', async () => {
    await loadPins([wirePin]);
    const adding = actions.toggleReaction(testMessage, '👍');
    const mutation = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`);
    const serverReactors = [ownReactor, { uid: 2, name: '另一位用户' }];
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: {
        chatId: testChat.id,
        messageId: testMessage.id,
        reactions: [{ emoji: '👍', count: 4, reactors: serverReactors }],
      },
    });
    expect(conversation.get(testMessage.id)?.message.reactions).toEqual([
      { emoji: '👍', count: 4, reactedByMe: true, reactors: serverReactors },
    ]);
    mutation.flush(null);
    await adding;
    expect(conversation.get(testMessage.id)?.message.reactions[0].count).toBe(4);

    const removing = actions.toggleReaction(conversation.get(testMessage.id)!.message, '👍');
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({
      count: 3,
      reactedByMe: false,
    });
    http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`).flush(null);
    await removing;
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [{ emoji: '👍', count: 5 }] },
    });
    expect(conversation.get(testMessage.id)?.message.reactions[0]).toMatchObject({
      count: 5,
      reactedByMe: false,
    });
    http.expectNone(() => true);
  });

  it('propagates mutation failure to the page without additional requests', async () => {
    const adding = actions.toggleReaction(testMessage, '👍');
    const failure = expect(adding).rejects.toBeDefined();
    http
      .expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`)
      .flush('', { status: 403, statusText: 'Forbidden' });
    await failure;
    http.expectNone(() => true);
  });
});
