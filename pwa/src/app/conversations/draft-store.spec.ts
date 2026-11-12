import { LinkPreviewInputStatus } from '../../generated/models';
import { stubIndexedDB } from '../storage/testing';
import { AccountStorage, AccountStore } from '../storage/account-storage';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { DraftStore } from './draft-store';
import { testMessage } from '../api/testing';

const chat = encodeId('9007199254741000');
const thread = encodeId('9007199254741001');

describe('DraftStore', () => {
  const user = signal({ uid: 1 });
  beforeEach(async () => {
    stubIndexedDB();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
    });
    user.set({ uid: 1 });
    TestBed.configureTestingModule({
      providers: [{ provide: SessionStore, useValue: { user } }],
    });
    await TestBed.inject(AccountStorage).activate(1);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps forward selections separate from text, topics and persistent storage', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    drafts.save(chat, undefined, 'existing text', thread);
    drafts.setForward(chat, undefined, sources);
    expect(drafts.forward(chat)).toBe(sources);
    expect(drafts.forward(chat, thread)).toBeUndefined();
    expect(drafts.get(chat)).toMatchObject({ text: 'existing text', replyTo: '9007199254741001' });
    expect(JSON.stringify(TestBed.inject(AccountStorage).entries(AccountStore.Drafts))).not.toContain('sources');
    drafts.setForward(chat, undefined);
    expect(drafts.get(chat)?.text).toBe('existing text');
    drafts.setForward(chat, undefined, sources);
    await TestBed.inject(AccountStorage).activate(2);
    user.set({ uid: 2 });
    expect(drafts.forward(chat)).toBeUndefined();
    await TestBed.inject(AccountStorage).activate(1);
    user.set({ uid: 1 });
    expect(drafts.forward(chat)).toBeUndefined();
  });

  it('restores link choices and an edit draft separately from the send draft', async () => {
    const choices = [{ url: 'https://example.com/', status: LinkPreviewInputStatus.disabled }];
    const edit = { messageId: '9007199254741003', text: 'https://other.example/', linkPreviews: choices };
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, thread, 'https://example.com/', undefined, choices, edit);
    await TestBed.inject(AccountStorage).settled();
    await TestBed.inject(AccountStorage).activate(2);
    user.set({ uid: 2 });
    expect(drafts.get(chat, thread)).toBeUndefined();
    await TestBed.inject(AccountStorage).activate(1);
    user.set({ uid: 1 });
    expect(drafts.get(chat, thread)).toMatchObject({ text: 'https://example.com/', linkPreviews: choices, edit });
    drafts.save(chat, thread, '', undefined, undefined, edit);
    expect(drafts.get(chat, thread)?.edit).toEqual(edit);
    drafts.save(chat, thread, '', undefined);
    expect(drafts.get(chat, thread)).toBeUndefined();
  });

  it('persists separate chat and topic drafts, including the exact reply ID', async () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '主会话');
    drafts.save(chat, thread, '话题', thread);
    await TestBed.inject(AccountStorage).settled();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: SessionStore, useValue: { user } }],
    });
    await TestBed.inject(AccountStorage).activate(1);
    const restored = TestBed.inject(DraftStore);
    expect(restored.get(chat)?.text).toBe('主会话');
    expect(restored.get(chat, thread)).toMatchObject({ text: '话题', replyTo: '9007199254741001' });
  });

  it('isolates accounts and deletes cleared drafts from storage', async () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '账号一');
    await TestBed.inject(AccountStorage).activate(2);
    user.set({ uid: 2 });
    expect(drafts.get(chat)).toBeUndefined();
    drafts.save(chat, undefined, '账号二');
    await TestBed.inject(AccountStorage).activate(1);
    user.set({ uid: 1 });
    expect(drafts.get(chat)?.text).toBe('账号一');
    drafts.clear(chat);
    await TestBed.inject(AccountStorage).settled();
    TestBed.inject(AccountStorage).deactivate();
    await TestBed.inject(AccountStorage).activate(1);
    expect(TestBed.inject(AccountStorage).entries(AccountStore.Drafts)).toEqual({});
  });

  it('does not write empty drafts or clear an already empty slot', async () => {
    const drafts = TestBed.inject(DraftStore);
    const write = vi.spyOn(TestBed.inject(AccountStorage), 'set');
    drafts.save(chat, undefined, '  ');
    drafts.clear(chat);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not change draft order when saving unchanged content and removes blank text', async () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '保留');
    const previous = drafts.get(chat);
    drafts.save(chat, undefined, '保留');
    expect(drafts.get(chat)).toBe(previous);
    drafts.save(chat, undefined, '  ');
    expect(drafts.get(chat)).toBeUndefined();
  });
});
