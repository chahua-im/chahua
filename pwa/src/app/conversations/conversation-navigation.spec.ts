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
    router.url = '/chats';
    router.navigate.mockReset().mockResolvedValue(true);
    modals.getTop.mockReset().mockResolvedValue(undefined);
    modals.dismiss.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: router },
        { provide: ModalController, useValue: modals },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: Connection, useValue: mockRealtime() },
      ],
    });
  });

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
});
