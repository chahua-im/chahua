import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { SavedMessageResponse } from '../../generated/models';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId, encodeId } from '../api/snowflake-id';
import { testChat, testMessage } from '../api/testing';
import { SavedMessageStore } from './saved-message-store';

const savedRow = (messageId: string) => ({ originalMessageId: encodeId(messageId) }) as SavedMessageResponse;

describe('SavedMessageStore', () => {
  let store: SavedMessageStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    store = TestBed.inject(SavedMessageStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load() {
    const loading = store.ensure(testChat.id);
    http
      .expectOne((request) => request.url.endsWith('/saved-messages'))
      .flush({
        savedMessages: [savedRow('9007199254741001')],
        nextCursor: encodeId('9007199254741001'),
      });
    // The next page is requested once the first response settles.
    await new Promise((resolve) => setTimeout(resolve));
    http
      .expectOne((request) => request.url.endsWith('/saved-messages') && request.params.has('before'))
      .flush({ savedMessages: [savedRow('9007199254741002')] });
    await loading;
  }

  it('reads every page of the chat before answering saved state', async () => {
    await load();
    expect(store.isSaved(testChat.id, encodeId('9007199254741001'))).toBe(true);
    expect(store.isSaved(testChat.id, encodeId('9007199254741002'))).toBe(true);
    expect(store.isSaved(testChat.id, testMessage.id)).toBe(false);
  });

  it('applies a save before the request and reverts it when the request fails', async () => {
    await load();
    const saving = store.save(testMessage);
    expect(store.isSaved(testChat.id, testMessage.id)).toBe(true);
    const failure = expect(saving).rejects.toBeDefined();
    http
      .expectOne(`/_api/saved-messages/${decodeId(testMessage.id)}`)
      .flush('', { status: 403, statusText: 'Forbidden' });
    await failure;
    expect(store.isSaved(testChat.id, testMessage.id)).toBe(false);
  });

  it('removes a saved message before the request and restores it when the request fails', async () => {
    await load();
    const message = { ...testMessage, id: encodeId('9007199254741001') };
    const removing = store.unsave(message);
    expect(store.isSaved(testChat.id, message.id)).toBe(false);
    const failure = expect(removing).rejects.toBeDefined();
    http
      .expectOne(`/_api/saved-messages/by-message/${decodeId(message.id)}`)
      .flush('', { status: 500, statusText: 'Server Error' });
    await failure;
    expect(store.isSaved(testChat.id, message.id)).toBe(true);
  });

  it('preserves an existing save when saving it again fails', async () => {
    await load();
    const message = { ...testMessage, id: encodeId('9007199254741001') };
    const saving = store.save(message);
    const failure = expect(saving).rejects.toBeDefined();
    http
      .expectOne(`/_api/saved-messages/${decodeId(message.id)}`)
      .flush('', { status: 500, statusText: 'Server Error' });
    await failure;
    expect(store.isSaved(testChat.id, message.id)).toBe(true);
  });
});
