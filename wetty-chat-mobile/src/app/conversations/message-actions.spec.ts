import { ConversationStore } from './conversation-store';
import { mockRealtime } from '../api/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ServerWsMessageType } from '../../generated/models';
import type { PinResponse, ServerWsMessage } from '../../generated/models';
import { jsonInterceptor } from '../api/json.interceptor';
import { testChat, testMessage, testUser, wireMessage } from '../api/testing';
import { Connection } from '../api/connection';
import { decodeId, encodeId } from '../api/snowflake-id';
import { MessageActions } from './message-actions';

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

  let conversation: ConversationStore;

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
      ],
    });
    scope = createEnvironmentInjector([ConversationStore, MessageActions], TestBed.inject(EnvironmentInjector));
    actions = scope.get(MessageActions);
    conversation = scope.get(ConversationStore);
    http = TestBed.inject(HttpTestingController);
    conversation.reset(testChat.id);
  });

  afterEach(() => {
    scope.destroy();
    http.verify();
  });

  async function loadPins(pins: (typeof wirePin)[] = []) {
    const loading = conversation.ensurePins();
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
    expect(conversation.pinFor(testMessage.id)?.message).toMatchObject({
      isDeleted: true,
      attachments: [],
      reactions: [],
    });
  });

  it.each(['👍', '#️⃣'])(
    'updates %s immediately and removes the last reaction without reading details',
    async (emoji) => {
      await loadPins([wirePin]);
      const adding = actions.toggleReaction(testMessage, emoji);
      expect(conversation.pinFor(testMessage.id)?.message.reactions).toEqual([{ emoji, count: 1, reactedByMe: true }]);
      const put = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent(emoji)}`);
      expect(put.request.method).toBe('PUT');
      put.flush(null);
      await adding;

      const removing = actions.toggleReaction(conversation.pinFor(testMessage.id)!.message, emoji);
      expect(conversation.pinFor(testMessage.id)?.message.reactions).toEqual([]);
      const deletion = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent(emoji)}`);
      expect(deletion.request.method).toBe('DELETE');
      deletion.flush(null);
      await removing;
      http.expectNone(() => true);
    },
  );

  it('keeps WebSocket totals and personal selections when the mutation finishes later', async () => {
    await loadPins([wirePin]);
    const adding = actions.toggleReaction(testMessage, '👍');
    const mutation = http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`);
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [{ emoji: '👍', count: 4 }] },
    });
    expect(conversation.pinFor(testMessage.id)?.message.reactions).toEqual([
      { emoji: '👍', count: 4, reactedByMe: true },
    ]);
    mutation.flush(null);
    await adding;
    expect(conversation.pinFor(testMessage.id)?.message.reactions[0].count).toBe(4);

    const removing = actions.toggleReaction(conversation.pinFor(testMessage.id)!.message, '👍');
    expect(conversation.pinFor(testMessage.id)?.message.reactions[0]).toMatchObject({
      count: 3,
      reactedByMe: false,
    });
    http.expectOne(`${messageUrl}/reactions/${encodeURIComponent('👍')}`).flush(null);
    await removing;
    events.next({
      type: ServerWsMessageType.reactionUpdated,
      payload: { chatId: testChat.id, messageId: testMessage.id, reactions: [{ emoji: '👍', count: 5 }] },
    });
    expect(conversation.pinFor(testMessage.id)?.message.reactions[0]).toMatchObject({
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
