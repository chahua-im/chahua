import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular';
import { Connection } from '../api/connection';
import { decodeId, encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { ConversationNavigation } from './conversation-navigation';
import { DraftStore } from './draft-store';

describe('Forward destination navigation', () => {
  const modals = { getTop: vi.fn(), dismiss: vi.fn() };
  const router = {
    url: '',
    createUrlTree: (commands: string[]) => commands.join('/'),
    serializeUrl: (url: string) => url,
    navigate: vi.fn(),
  };
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    router.url = '/chats';
    router.navigate.mockReset().mockResolvedValue(true);
    modals.getTop.mockReset().mockResolvedValue(undefined);
    modals.dismiss.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: router },
        { provide: ModalController, useValue: modals },
        {
          provide: SessionStore,
          useValue: {
            requireChatSettings: SessionStore.prototype.requireChatSettings,
            acceptChatSettings: SessionStore.prototype.acceptChatSettings,
            user: signal(testUser),
          },
        },
        { provide: Connection, useValue: mockRealtime() },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stages into an already open conversation without requiring another route activation', async () => {
    router.url = `/chats/chat/${decodeId(testChat.id)}`;
    const drafts = TestBed.inject(DraftStore);
    drafts.save(testChat.id, undefined, 'existing');
    expect(await TestBed.inject(ConversationNavigation).prepareForward(testChat.id, undefined, [testMessage])).toBe(
      true,
    );
    expect(router.navigate).not.toHaveBeenCalled();
    expect(drafts.forward(testChat.id)).toEqual([testMessage]);
    expect(drafts.get(testChat.id)?.text).toBe('existing');
  });

  it('stages a topic independently and navigates to that topic', async () => {
    const topic = encodeId('999');
    const drafts = TestBed.inject(DraftStore);
    await TestBed.inject(ConversationNavigation).prepareForward(testChat.id, topic, [testMessage]);
    expect(router.navigate).toHaveBeenCalledWith(['/chats/chat', decodeId(testChat.id), 'thread', '999']);
    expect(drafts.forward(testChat.id)).toBeUndefined();
    expect(drafts.forward(testChat.id, topic)).toEqual([testMessage]);
  });

  it('restores the previous forward when navigation fails', async () => {
    const drafts = TestBed.inject(DraftStore);
    const previous = [{ ...testMessage, id: encodeId('111') }];
    drafts.setForward(testChat.id, undefined, previous);
    router.navigate.mockResolvedValue(false);
    expect(await TestBed.inject(ConversationNavigation).prepareForward(testChat.id, undefined, [testMessage])).toBe(
      false,
    );
    expect(drafts.forward(testChat.id)).toBe(previous);
    expect(modals.getTop).not.toHaveBeenCalled();
    expect(modals.dismiss).not.toHaveBeenCalled();
  });

  it('keeps the picker until routing succeeds, then dismisses it with the navigation role', async () => {
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    modals.getTop.mockResolvedValueOnce({}).mockResolvedValue(undefined);
    const pending = TestBed.inject(ConversationNavigation).prepareForward(testChat.id, undefined, [testMessage]);
    expect(modals.getTop).not.toHaveBeenCalled();
    resolve(true);
    expect(await pending).toBe(true);
    expect(modals.dismiss).toHaveBeenCalledExactlyOnceWith(undefined, 'navigate');
  });

  it('does not restore the old account draft when a pending navigation fails after logout', async () => {
    const drafts = TestBed.inject(DraftStore);
    drafts.setForward(testChat.id, undefined, [testMessage]);
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const pending = TestBed.inject(ConversationNavigation).prepareForward(testChat.id, undefined, [testMessage]);
    TestBed.inject(SessionStore).user.set(undefined);
    resolve(false);
    await pending;
    expect(drafts.forward(testChat.id)).toBeUndefined();
  });

  it.each([undefined, encodeId('999')])(
    'moves all selected messages into destination topic %s after navigation succeeds',
    async (threadId) => {
      const drafts = TestBed.inject(DraftStore);
      const target = encodeId('222');
      const sources = [testMessage, { ...testMessage, id: encodeId('111') }];
      const origin = { chatId: testChat.id, threadId: encodeId('888') };
      drafts.setForward(origin.chatId, origin.threadId, sources);
      drafts.setForward(origin.chatId, undefined, [testMessage]);
      drafts.setForward(target, threadId, [testMessage]);
      drafts.save(origin.chatId, origin.threadId, 'original text', testMessage.id);
      drafts.save(target, threadId, 'destination text');
      let resolve!: (opened: boolean) => void;
      router.navigate.mockImplementation(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      );

      const pending = TestBed.inject(ConversationNavigation).prepareForward(target, threadId, sources, origin);
      expect(drafts.forward(origin.chatId, origin.threadId)).toBe(sources);
      expect(drafts.get(target, threadId)?.text).toBe('destination text');
      resolve(true);
      expect(await pending).toBe(true);
      expect(drafts.forward(origin.chatId, origin.threadId)).toBeUndefined();
      expect(drafts.forward(origin.chatId)).toEqual([testMessage]);
      expect(drafts.forward(target, threadId)).toEqual(sources);
      expect(drafts.get(origin.chatId, origin.threadId)).toMatchObject({
        text: 'original text',
        replyTo: decodeId(testMessage.id),
      });
      expect(drafts.get(target, threadId)?.text).toBe('destination text');
    },
  );

  it.each([false, new Error('navigation failed')])('preserves both drafts when a move fails: %s', async (result) => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    const previous = [{ ...testMessage, id: encodeId('111') }];
    drafts.setForward(testChat.id, undefined, sources);
    drafts.setForward(target, undefined, previous);
    drafts.save(testChat.id, undefined, 'forward comment');
    drafts.save(target, undefined, 'target draft', testMessage.id);
    const originalDraft = drafts.get(testChat.id);
    const targetDraft = drafts.get(target);
    if (result instanceof Error) router.navigate.mockRejectedValue(result);
    else router.navigate.mockResolvedValue(result);
    const pending = TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, {
      chatId: testChat.id,
    });
    if (result instanceof Error) await expect(pending).rejects.toThrow(result);
    else expect(await pending).toBe(false);
    expect(drafts.forward(testChat.id)).toBe(sources);
    expect(drafts.forward(target)).toBe(previous);
    expect(drafts.get(testChat.id)).toBe(originalDraft);
    expect(drafts.get(target)).toBe(targetDraft);
  });

  it('retains the selection when the same destination is chosen again', async () => {
    const sources = [testMessage];
    const drafts = TestBed.inject(DraftStore);
    const threadId = encodeId('999');
    router.url = `/chats/chat/${decodeId(testChat.id)}/thread/999`;
    drafts.setForward(testChat.id, threadId, sources);
    drafts.save(testChat.id, threadId, 'forward comment');
    const originalDraft = drafts.get(testChat.id, threadId);
    expect(
      await TestBed.inject(ConversationNavigation).prepareForward(testChat.id, threadId, sources, {
        chatId: testChat.id,
        threadId,
      }),
    ).toBe(true);
    expect(drafts.forward(testChat.id, threadId)).toEqual(sources);
    expect(drafts.get(testChat.id, threadId)).toBe(originalDraft);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not move a selection that was replaced while the picker was open', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const replacement = [{ ...testMessage, id: encodeId('111') }];
    drafts.setForward(testChat.id, undefined, replacement);
    expect(
      await TestBed.inject(ConversationNavigation).prepareForward(encodeId('222'), undefined, sources, {
        chatId: testChat.id,
      }),
    ).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(drafts.forward(testChat.id)).toBe(replacement);
    expect(drafts.forward(encodeId('222'))).toBeUndefined();
  });

  it('does not clear a newer origin draft when a move finishes', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const replacement = [{ ...testMessage, id: encodeId('111') }];
    drafts.setForward(testChat.id, undefined, sources);
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const pending = TestBed.inject(ConversationNavigation).prepareForward(encodeId('222'), undefined, sources, {
      chatId: testChat.id,
    });
    drafts.setForward(testChat.id, undefined, replacement);
    resolve(true);
    await pending;
    expect(drafts.forward(testChat.id)).toBe(replacement);
    expect(drafts.forward(encodeId('222'))).toEqual(sources);
  });

  it('keeps multiline comments in the original chat when moving to an empty destination', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    const text = 'first line\n\nsecond line @[uid:1]';
    drafts.setForward(testChat.id, undefined, sources);
    drafts.save(testChat.id, undefined, text);
    await TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, { chatId: testChat.id });
    expect(drafts.get(target)).toBeUndefined();
    expect(drafts.get(testChat.id)?.text).toBe(text);
  });

  it('keeps destination text and reply target when moving a forward', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    drafts.setForward(testChat.id, undefined, sources);
    drafts.save(testChat.id, undefined, 'comment');
    drafts.save(target, undefined, 'existing', testMessage.id);
    await TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, { chatId: testChat.id });
    expect(drafts.get(target)).toMatchObject({ text: 'existing', replyTo: decodeId(testMessage.id) });
  });

  it('does not replace newer destination text when a move fails', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    drafts.setForward(testChat.id, undefined, sources);
    drafts.save(testChat.id, undefined, 'comment');
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const pending = TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, {
      chatId: testChat.id,
    });
    drafts.save(target, undefined, 'newer draft');
    resolve(false);
    await pending;
    expect(drafts.get(target)?.text).toBe('newer draft');
    expect(drafts.get(testChat.id)?.text).toBe('comment');
  });

  it('does not restore another account text after a failed move', async () => {
    const drafts = TestBed.inject(DraftStore);
    const sources = [testMessage];
    const target = encodeId('222');
    drafts.setForward(testChat.id, undefined, sources);
    drafts.save(testChat.id, undefined, 'comment');
    drafts.save(target, undefined, 'previous account draft');
    let resolve!: (opened: boolean) => void;
    router.navigate.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    const pending = TestBed.inject(ConversationNavigation).prepareForward(target, undefined, sources, {
      chatId: testChat.id,
    });
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: testUser.uid + 1 });
    drafts.save(target, undefined, 'new account draft');
    resolve(false);
    await pending;
    expect(drafts.get(target)?.text).toBe('new account draft');
    expect(drafts.get(testChat.id)).toBeUndefined();
  });
});
