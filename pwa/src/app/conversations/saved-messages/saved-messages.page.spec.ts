import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { MessageType } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { encodeId } from '../../api/snowflake-id';
import { mockRealtime, testUser, wireChat, wireMessage } from '../../api/testing';
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
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SavedMessagesPage],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: Preferences, useValue: { showAllAvatars: () => false } },
        { provide: Connection, useValue: mockRealtime({ events$: new Subject(), resync$: new Subject() }) },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SavedMessagesPage);
    page = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  function list(): SavedMessageList {
    return fixture.debugElement.query(By.directive(SavedMessageList)).componentInstance;
  }

  async function saved() {
    fixture.detectChanges();
    http.expectOne('/_api/saved-messages?limit=50').flush({ savedMessages: [savedSnapshot()], nextCursor: '499' });
    await fixture.whenStable();
    fixture.detectChanges();
  }

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
    http
      .expectOne('/_api/saved-messages?limit=50&before=499')
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
      queryParams: { message: wireMessage.id },
    });
    await list()['locateSaved']({ ...list()['saved']()[0], canLocateContext: false });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('removes a saved entry by snapshot ID rather than original message ID', async () => {
    await saved();
    const removing = list()['removeSaved'](list()['saved']()[0]);
    http.expectOne('/_api/saved-messages/by-id/500').flush(null);
    await removing;
    expect(list()['saved']()).toEqual([]);
  });

  it('ignores an old saved page after leaving and reentering the virtual conversation', async () => {
    fixture.detectChanges();
    const old = http.expectOne('/_api/saved-messages?limit=50');
    page.ionViewDidLeave();
    page.ionViewDidEnter();
    http.expectOne('/_api/saved-messages?limit=50').flush({ savedMessages: [{ ...savedSnapshot(), id: '501' }] });
    expect(old.cancelled).toBe(true);
    await fixture.whenStable();
    expect(
      list()
        ['saved']()
        .map((item) => item.id),
    ).toEqual([encodeId('501')]);
    expect(list()['nextCursor']()).toBeUndefined();
  });

  it('cancels collection HTTP when the page is destroyed', async () => {
    fixture.detectChanges();
    const request = http.expectOne('/_api/saved-messages?limit=50');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
});
