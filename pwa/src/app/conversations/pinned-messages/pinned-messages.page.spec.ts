import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupRole, MessageType, ServerWsMessageType, type MessageResponse } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { encodeId } from '../../api/snowflake-id';
import { mockRealtime, testUser, wireChat, wireMessage } from '../../api/testing';
import { MessageAction } from '../../messages/message-menu/message-menu';
import { MessageNotice } from '../../messages/message-notice';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { PinnedMessagesPage } from './pinned-messages.page';

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

describe('PinnedMessagesPage', () => {
  let fixture: ComponentFixture<PinnedMessagesPage>;
  let page: PinnedMessagesPage;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PinnedMessagesPage],
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
    fixture = TestBed.createComponent(PinnedMessagesPage);
    page = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  async function pins(role = GroupRole.admin, thread = false, deleted = false) {
    fixture.componentRef.setInput('id', wireChat.id);
    if (thread) fixture.componentRef.setInput('threadId', '100');
    fixture.detectChanges();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...structuredClone(wireChat), myRole: role });
    http.expectOne(`/_api/chats/${wireChat.id}${thread ? '/threads/100' : ''}/pins`).flush({
      pins: [
        {
          id: '200',
          chatId: wireChat.id,
          pinnedAt: '2026-09-07T12:00:00Z',
          pinnedBy: 1,
          message: { ...structuredClone(wireMessage), isDeleted: deleted },
          ...(thread ? { threadRootId: '100' } : {}),
        },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    return page['pins']().items()[0];
  }

  function select(message: MessageResponse) {
    page['menu']()!['selection'].set({
      messageId: message.id,
      element: document.createElement('div'),
      rect: new DOMRect(),
      own: true,
    });
  }

  async function settle() {
    for (let step = 0; step < 8; step++) await Promise.resolve();
  }

  it('renders scoped pins without a composer or real-conversation read requests', async () => {
    const pin = await pins(GroupRole.admin, true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('置顶消息');
    expect(fixture.nativeElement.querySelector('app-message')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('ion-textarea')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-footer')).toBeNull();
    expect(page['backHref']()).toBe(`/chats/chat/${wireChat.id}/thread/100`);
    expect(fixture.nativeElement.querySelector('.collection-actions')).toBeNull();
    expect(fixture.nativeElement.querySelector('.message-date')).not.toBeNull();
    page['locateMessage'](pin.message, pin.message.id);
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', '100'], {
      queryParams: { message: wireMessage.id },
    });
    http.expectNone((request) => request.url.endsWith('/read') || request.url.endsWith('/read-state'));
  });

  it.each([false, true])(
    'omits recalled pins from messages and date groups, including initial loading: %s',
    async (deleted) => {
      const pin = await pins(GroupRole.admin, false, deleted);
      if (!deleted)
        TestBed.inject(Connection).acceptChange({
          type: ServerWsMessageType.messageDeleted,
          payload: { ...pin.message, isDeleted: true },
        });
      await settle();
      fixture.detectChanges();
      expect(page['messages']()).toEqual([]);
      expect(fixture.nativeElement.querySelector('app-message, .message-date')).toBeNull();
      expect(fixture.nativeElement.querySelector('.message-list').textContent).toContain('暂无置顶消息');
    },
  );

  it('requires confirmation before deleting a pin from its own thread scope', async () => {
    const pin = await pins(GroupRole.admin, true);
    select(pin.message);
    await page['menu']()!['choose'](MessageAction.Pin);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-alert').isOpen).toBe(true);
    http.expectNone((request) => request.method === 'DELETE');
    await page['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'cancel' } }));
    expect(page['pins']().items()).toHaveLength(1);
    select(pin.message);
    await page['menu']()!['choose'](MessageAction.Pin);
    const removing = page['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    await Promise.resolve();
    http.expectOne(`/_api/chats/${wireChat.id}/threads/100/pins/200`).flush(null);
    await removing;
    expect(page['pins']().items()).toEqual([]);
  });

  it('does not offer or execute unpin for a regular member', async () => {
    const pin = await pins(GroupRole.member);
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-button')].some((button) =>
        (button as HTMLElement).textContent?.includes('取消置顶'),
      ),
    ).toBe(false);
    select(pin.message);
    await page['menu']()!['choose'](MessageAction.Pin);
    expect(page['menu']()!['confirmation']()).toBeUndefined();
    await page['menu']()!['confirm'](new CustomEvent('didDismiss', { detail: { role: 'confirm' } }));
    http.expectNone((request) => request.method === 'DELETE');
    page['menu']()!['selection'].set(undefined);
  });

  it('saves a pinned original message using the saved-messages API', async () => {
    const pin = await pins();
    select(pin.message);
    const saving = page['menu']()!['choose'](MessageAction.Save);
    await settle();
    http.expectOne(`/_api/saved-messages/${wireMessage.id}`).flush(savedSnapshot());
    await saving;
    expect(page['menu']()!['notice']()).toBe(MessageNotice.Saved);
  });

  it('opens the original topic for replies and quoted-message jumps', async () => {
    const pin = await pins(GroupRole.admin, true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    select(pin.message);
    await page['menu']()!['choose'](MessageAction.Reply);
    expect(navigate).toHaveBeenLastCalledWith(['/chats/chat', wireChat.id, 'thread', '100'], {
      queryParams: { reply: wireMessage.id },
    });
    page['locateMessage'](pin.message, encodeId('101'));
    expect(navigate).toHaveBeenLastCalledWith(['/chats/chat', wireChat.id, 'thread', '100'], {
      queryParams: { message: '101' },
    });
    http.expectNone((request) => request.url.endsWith('/read') || request.url.endsWith('/read-state'));
  });

  it('opens a pinned message as a topic from the normal message menu', async () => {
    const pin = await pins();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    select(pin.message);
    await page['menu']()!['choose'](MessageAction.Thread);
    expect(navigate).toHaveBeenCalledWith(['/chats/chat', wireChat.id, 'thread', wireMessage.id]);
  });
});
