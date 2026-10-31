import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { vi } from 'vitest';
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
    peer.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function list(): SavedMessageList {
    return fixture.debugElement.query(By.directive(SavedMessageList)).componentInstance;
  }

  async function saved() {
    fixture.detectChanges();
    peer.expect('savedMessages.list', { limit: 50 }).flush({ savedMessages: [savedSnapshot()], nextCursor: '499' });
    await fixture.whenStable();
    fixture.detectChanges();
  }

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
    await fixture.whenStable();
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
    await fixture.whenStable();
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
    await fixture.whenStable();
    fixture.detectChanges();
    const entry = fixture.nativeElement.querySelector('.system-message') as HTMLElement;
    entry.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    expect(list()['menu']()?.item.id).toBe(encodeId('500'));
    expect(fixture.nativeElement.querySelector('.collection-actions')).toBeNull();
  });
});
