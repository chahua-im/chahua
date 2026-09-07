import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DraftStore } from './draft-store';
import { SessionStore } from '../session/session-store';
import { encodeId } from '../api/snowflake-id';

const chat = encodeId('9007199254741000');
const thread = encodeId('9007199254741001');

describe('DraftStore', () => {
  const user = signal({ uid: 1 });
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    user.set({ uid: 1 });
    TestBed.configureTestingModule({ providers: [{ provide: SessionStore, useValue: { user } }] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('persists separate chat and topic drafts, including the exact reply ID', () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '主会话');
    drafts.save(chat, thread, '话题', thread);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: SessionStore, useValue: { user } }] });
    const restored = TestBed.inject(DraftStore);
    expect(restored.get(chat)?.text).toBe('主会话');
    expect(restored.get(chat, thread)).toMatchObject({ text: '话题', replyTo: '9007199254741001' });
  });

  it('isolates accounts and deletes cleared drafts from storage', () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '账号一');
    user.set({ uid: 2 });
    expect(drafts.get(chat)).toBeUndefined();
    drafts.save(chat, undefined, '账号二');
    user.set({ uid: 1 });
    expect(drafts.get(chat)?.text).toBe('账号一');
    drafts.clear(chat);
    expect(JSON.parse(window.localStorage.getItem('chahua.drafts.1')!)).toEqual({});
  });

  it('does not change draft order when saving unchanged content and removes blank text', () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.save(chat, undefined, '保留');
    const previous = drafts.get(chat);
    drafts.save(chat, undefined, '保留');
    expect(drafts.get(chat)).toBe(previous);
    drafts.save(chat, undefined, '  ');
    expect(drafts.get(chat)).toBeUndefined();
  });
});
