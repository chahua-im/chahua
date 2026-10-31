import { TestBed } from '@angular/core/testing';
import { RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { testChat, testMessage } from '../api/testing';
import { SavedMessageStore } from './saved-message-store';

const wireSavedRow = (messageId: string) => ({ originalMessageId: messageId });

describe('SavedMessageStore', () => {
  let store: SavedMessageStore;
  let peer: RpcTestPeer;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...provideRpcTesting()] });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    store = TestBed.inject(SavedMessageStore);
  });

  afterEach(() => peer.verify());

  async function load() {
    const loading = store.ensure(testChat.id);
    peer.expect('savedMessages.listForChat', { chatId: decodeId(testChat.id), limit: 50 }).flush({
      savedMessages: [wireSavedRow('9007199254741001')],
      nextCursor: '9007199254741001',
    });
    await Promise.resolve();
    peer
      .expect('savedMessages.listForChat', { chatId: decodeId(testChat.id), limit: 50, before: '9007199254741001' })
      .flush({
        savedMessages: [wireSavedRow('9007199254741002')],
      });
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
    peer.expect('savedMessages.save', { messageId: decodeId(testMessage.id) }).error(RpcErrorCode.Forbidden);
    await expect(saving).rejects.toBeDefined();
    expect(store.isSaved(testChat.id, testMessage.id)).toBe(false);
  });

  it('removes a saved message before the request and restores it when the request fails', async () => {
    await load();
    const message = { ...testMessage, id: encodeId('9007199254741001') };
    const removing = store.unsave(message);
    expect(store.isSaved(testChat.id, message.id)).toBe(false);
    peer.expect('savedMessages.deleteByMessage', { messageId: decodeId(message.id) }).error(RpcErrorCode.Internal);
    await expect(removing).rejects.toBeDefined();
    expect(store.isSaved(testChat.id, message.id)).toBe(true);
  });

  it('preserves an existing save when saving it again fails', async () => {
    await load();
    const message = { ...testMessage, id: encodeId('9007199254741001') };
    const saving = store.save(message);
    peer.expect('savedMessages.save', { messageId: decodeId(message.id) }).error(RpcErrorCode.Internal);
    await expect(saving).rejects.toBeDefined();
    expect(store.isSaved(testChat.id, message.id)).toBe(true);
  });
});
