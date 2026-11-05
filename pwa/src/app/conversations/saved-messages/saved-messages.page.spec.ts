import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { vi } from 'vitest';
import { Connection, ResyncReason } from '../../api/connection';
import { RpcErrorCode } from '../../api/rpc-error';
import { Subject } from 'rxjs';
import { MessageType } from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { encodeId } from '../../api/snowflake-id';
import { testUser, wireChat, wireMessage } from '../../api/testing';
import { SavedMessageList } from '../../messages/saved-message-list/saved-message-list';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { SavedMessagesPage } from './saved-messages.page';

const savedSnapshot = () => ({
  id: '500',
  originalChatId: wireChat.id,
  originalMessageId: wireMessage.id,
  originalThreadRootId: '100',
  originalCreatedAt: '2026-08-01T12:00:00Z',
  originalSenderUid: 1,
  savedAt: '2026-09-07T12:00:00Z',
  canLocateContext: true,
  chat: { id: wireChat.id, name: '保存时的群名' },
  sender: { uid: 1, name: '保存时的作者', gender: 0 },
  message: '收藏快照内容',
  messageType: MessageType.text,
  attachments: [],
  mentions: [],
});

describe('SavedMessagesPage', () => {
  let fixture: ComponentFixture<SavedMessagesPage>;
  let page: SavedMessagesPage;
  let peer: RpcTestPeer;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SavedMessagesPage],
      providers: [
        provideIonicAngular({ animated: false }),
        provideRouter([
          { path: 'chats/saved', children: [] },
          { path: 'media', children: [], data: { modal: true } },
          { path: 'chats/saved/500/forwarded', children: [], data: { preserveConversation: true } },
          { path: 'chats', children: [] },
        ]),
        provideRpcTesting(),
        SessionStore,
        Preferences,
      ],
    }).compileComponents();
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    TestBed.inject(SessionStore).user.set(testUser);
    fixture = TestBed.createComponent(SavedMessagesPage);
    page = fixture.componentInstance;
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  function list(): SavedMessageList {
    return fixture.debugElement.query(By.directive(SavedMessageList)).componentInstance;
  }

  async function settle() {
    // A refreshed range commits after the page reader and range reader settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await fixture.whenStable();
  }

  async function saved() {
    fixture.detectChanges();
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [savedSnapshot()], nextCursor: '499' });
    await settle();
    fixture.detectChanges();
  }

  function refresh() {
    (TestBed.inject(Connection)['resync'] as Subject<ResyncReason>).next(ResyncReason.Foreground);
  }

  it('updates an open menu to the refreshed source permissions without replacing its row', async () => {
    await saved();
    const item = list()['saved']()[0];
    const event = new MouseEvent('contextmenu');
    const row = fixture.nativeElement.querySelector('app-message');
    list()['menu'].set({ item, event });
    refresh();
    expect(list()['menu']()?.item).toBe(item);
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [{ ...savedSnapshot(), canLocateContext: false }],
    });
    await settle();
    const selection = list()['menu']()!;
    expect(selection.item).toBe(list()['saved']()[0]);
    expect(selection.item.canLocateContext).toBe(false);
    expect(selection.event).toBe(event);
    expect(fixture.nativeElement.querySelector('app-message')).toBe(row);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await list()['locateSaved'](selection.item);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes the menu for a remotely removed snapshot and ignores its stale delete action', async () => {
    await saved();
    const item = list()['saved']()[0];
    list()['menu'].set({ item, event: new MouseEvent('contextmenu') });
    refresh();
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [] });
    await settle();
    expect(list()['menu']()).toBeUndefined();
    await list()['removeSaved'](item);
    peer.expectNone('savedMessages.delete');
    expect(list()['saved']()).toEqual([]);
    expect(list()['removing']()).toBe(false);
  });

  it('rolls back the current snapshot when a stale delete action fails after refresh', async () => {
    await saved();
    const previous = list()['saved']()[0];
    refresh();
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [{ ...savedSnapshot(), canLocateContext: false }],
    });
    await settle();
    const current = list()['saved']()[0];
    const removing = list()['removeSaved'](previous);
    peer.expect('savedMessages.delete', { savedMessageId: '500' }).error(RpcErrorCode.Unavailable);
    await removing;
    expect(list()['saved']()).toEqual([current]);
    expect(list()['saved']()[0].canLocateContext).toBe(false);
    expect(list()['removeFailed']()).toBe(true);
  });

  it('keeps rows and pagination on refresh failure and retries from the first page', async () => {
    await saved();
    const node = fixture.nativeElement.querySelector('app-message');
    refresh();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(list()['nextCursor']()).toBe(encodeId('499'));
    peer.expect('savedMessages.list', { limit: 50 }).error(RpcErrorCode.Unavailable);
    await settle();
    fixture.detectChanges();
    expect(list()['failed']()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(list()['nextCursor']()).toBe(encodeId('499'));
    list()['retry']();
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [savedSnapshot()], nextCursor: '498' });
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(list()['nextCursor']()).toBe(encodeId('498'));
    expect(list()['failed']()).toBe(false);
  });

  it('refreshes the loaded depth atomically and retains rows if a later refresh page fails', async () => {
    await saved();
    const more = list()['load'](true);
    peer.expect('savedMessages.list', { limit: 50, before: '499' }).flush({
      savedMessages: [{ ...savedSnapshot(), id: '499' }],
      nextCursor: '498',
    });
    await more;
    const previous = list()['saved']();
    refresh();
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [{ ...savedSnapshot(), message: 'new snapshot' }],
      nextCursor: '499',
    });
    await settle();
    expect(list()['saved']()).toBe(previous);
    peer.expect('savedMessages.list', { limit: 50, before: '499' }).error(RpcErrorCode.Unavailable);
    await settle();
    expect(list()['saved']()).toBe(previous);
    expect(list()['nextCursor']()).toBe(encodeId('498'));
    list()['retry']();
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [{ ...savedSnapshot(), message: 'new snapshot' }],
      nextCursor: '499',
    });
    await settle();
    peer.expect('savedMessages.list', { limit: 50, before: '499' }).flush({
      savedMessages: [{ ...savedSnapshot(), id: '499' }],
      nextCursor: '497',
    });
    await settle();
    expect(list()['saved']()).toHaveLength(2);
    expect(list()['saved']()[0].message).toBe('new snapshot');
    expect(list()['nextCursor']()).toBe(encodeId('497'));
  });

  it('defers resync until an optimistic deletion settles and preserves its rollback', async () => {
    await saved();
    const removing = list()['removeSaved'](list()['saved']()[0]);
    refresh();
    refresh();
    peer.expectNone('savedMessages.list');
    peer.expect('savedMessages.delete').error(RpcErrorCode.Unavailable);
    await removing;
    expect(list()['saved']()).toHaveLength(1);
    expect(list()['removeFailed']()).toBe(true);
    peer.expect('savedMessages.list', { limit: 50 }).error(RpcErrorCode.Unavailable);
    await settle();
    expect(list()['saved']()).toHaveLength(1);
  });

  it('clears the old account and ignores its pending refresh response', async () => {
    await saved();
    refresh();
    const old = peer.expect('savedMessages.list');
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    fixture.detectChanges();
    expect(list()['saved']()).toEqual([]);
    old.flush({ savedMessages: [savedSnapshot()] });
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [{ ...savedSnapshot(), id: '501' }] });
    await settle();
    expect(
      list()
        ['saved']()
        .map((item) => item.id),
    ).toEqual([encodeId('501')]);
  });

  it('clears saved content when a refresh confirms access denial', async () => {
    await saved();
    refresh();
    peer.expect('savedMessages.list').error(RpcErrorCode.Forbidden);
    await settle();
    expect(list()['saved']()).toEqual([]);
    expect(list()['nextCursor']()).toBeUndefined();
    expect(list()['failed']()).toBe(true);
  });

  it('labels yesterday using the original send date instead of the save date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    fixture.detectChanges();
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [
        {
          ...savedSnapshot(),
          originalCreatedAt: new Date(2026, 11, 31, 14, 30).toISOString(),
          savedAt: new Date().toISOString(),
        },
      ],
    });
    await settle();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.saved-source').textContent).toContain('昨天');
    expect(fixture.nativeElement.querySelector('app-message time').textContent.trim()).toBe('14:30');
  });

  it('paginates immutable saved snapshots and locates the original topic message', async () => {
    await saved();
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('收藏');
    expect(fixture.nativeElement.textContent).toContain('保存时的群名');
    expect(fixture.nativeElement.textContent).toContain('保存时的作者');
    expect(fixture.nativeElement.querySelector('app-message')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.reply-button')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-textarea')).toBeNull();
    expect(list()['saved']()[0]).not.toHaveProperty('clientGeneratedId');
    const loading = list()['load'](true);
    peer
      .expect('savedMessages.list', { limit: 50, before: '499' })
      .flush({ savedMessages: [savedSnapshot(), { ...savedSnapshot(), id: '499' }] });
    await loading;
    expect(
      list()
        ['saved']()
        .map((item) => item.id),
    ).toEqual([encodeId('500'), encodeId('499')]);
    expect(list()['nextCursor']()).toBeUndefined();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await list()['locateSaved'](list()['saved']()[0]);
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', '100'], {
      fragment: `msg=${wireMessage.id}`,
    });
    await list()['locateSaved']({ ...list()['saved']()[0], canLocateContext: false });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('removes a saved entry by snapshot ID rather than original message ID', async () => {
    await saved();
    const removing = list()['removeSaved'](list()['saved']()[0]);
    expect(list()['saved']()).toEqual([]);
    peer.expect('savedMessages.delete', { savedMessageId: '500' }).flush(null);
    await removing;
    expect(list()['saved']()).toEqual([]);
  });

  it('ignores an old saved page after leaving and reentering the virtual conversation', async () => {
    fixture.detectChanges();
    const old = peer.expect('savedMessages.list', { limit: 50 });
    page.ionViewDidLeave();
    fixture.detectChanges();
    page.ionViewDidEnter();
    fixture.detectChanges();
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [{ ...savedSnapshot(), id: '501' }] });
    old.flush({ savedMessages: [savedSnapshot()] });
    await settle();
    expect(
      list()
        ['saved']()
        .map((item) => item.id),
    ).toEqual([encodeId('501')]);
    expect(list()['nextCursor']()).toBeUndefined();
  });

  it('cancels collection reads when the page is destroyed without accepting a late reply', async () => {
    fixture.detectChanges();
    const collection = list();
    const request = peer.expect('savedMessages.list', { limit: 50 });
    fixture.destroy();
    request.flush({ savedMessages: [savedSnapshot()] });
    expect(collection['saved']()).toEqual([]);
  });

  it('restores an optimistically removed snapshot if deletion fails', async () => {
    await saved();
    const item = list()['saved']()[0];
    const removing = list()['removeSaved'](item);
    expect(list()['saved']()).toEqual([]);
    peer.expect('savedMessages.delete', { savedMessageId: '500' }).error(1500);
    await removing;
    expect(list()['saved']()).toEqual([item]);
    expect(list()['removeFailed']()).toBe(true);
  });

  it('preserves saved rows beneath media details and releases them when leaving the collection', async () => {
    await saved();
    const node = fixture.nativeElement.querySelector('app-message');
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/media');
    page.ionViewDidLeave();
    await router.navigateByUrl('/chats/saved');
    page.ionViewDidEnter();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    peer.expectNone('savedMessages.list');
    await router.navigateByUrl('/media');
    page.ionViewDidLeave();
    await router.navigateByUrl('/chats');
    expect(fixture.nativeElement.querySelector('app-saved-message-list')).toBeNull();
  });

  it('retains the loaded collection and pagination while reading forwarded records', async () => {
    await saved();
    const collection = list();
    const node = fixture.nativeElement.querySelector('app-message');
    await TestBed.inject(Router).navigateByUrl('/chats/saved/500/forwarded');
    page.ionViewDidLeave();
    expect(list()).toBe(collection);
    await TestBed.inject(Router).navigateByUrl('/chats/saved');
    page.ionViewDidEnter();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    expect(list()['nextCursor']()).toBe(encodeId('499'));
    peer.expectNone('savedMessages.list');
  });

  it('offers the saved-message menu for system snapshots without per-row action buttons', async () => {
    fixture.detectChanges();
    peer.expect('savedMessages.list', { limit: 50 }).flush({
      savedMessages: [{ ...savedSnapshot(), messageType: MessageType.system, message: 'joined the chat' }],
    });
    await settle();
    fixture.detectChanges();
    const entry = fixture.nativeElement.querySelector('.system-message') as HTMLElement;
    entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    expect(list()['menu']()?.item.id).toBe(encodeId('500'));
    expect(fixture.nativeElement.querySelector('.collection-actions')).toBeNull();
  });
});
