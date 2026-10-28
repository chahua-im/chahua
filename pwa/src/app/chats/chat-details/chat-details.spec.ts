import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, IonToast, ModalController } from '@ionic/angular';
import { archive, archiveOutline, notificationsOutline } from 'ionicons/icons';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  ChatAttachmentKindFilter,
  FriendPresenceOverride,
  GroupKind,
  GroupRole,
  MembershipMessageVisibility,
  PrivacyExceptionKind,
  ServerWsMessageType,
  SpeakingMode,
  type ServerWsMessage,
} from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireChat, wireMessage } from '../../api/testing';
import { PanelNavigation } from '../../navigation/panel-navigation';
import { Presence } from '../../presence/presence';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { ChatDetails, DetailView } from './chat-details';

describe('ChatDetails', () => {
  let http: HttpTestingController;
  const events = new Subject<ServerWsMessage>();
  const realtime = mockRealtime({ events$: events });
  const alert = { present: vi.fn(), onDidDismiss: vi.fn() };
  let presence: Presence;
  beforeEach(() => {
    vi.spyOn(IonToast.prototype, 'present').mockResolvedValue();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: realtime },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ChatListStore, useValue: { refreshChats: vi.fn() } },
        { provide: AlertController, useValue: { create: vi.fn().mockResolvedValue(alert) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    presence = TestBed.inject(Presence);
    vi.spyOn(presence, 'invalidateUsers');
  });
  afterEach(() => http.verify());

  function createDetails() {
    const fixture = TestBed.createComponent(ChatDetails);
    const panels = TestBed.inject(PanelNavigation);
    vi.spyOn(panels, 'updatePage').mockImplementation(async (view) => {
      fixture.componentRef.setInput('view', view);
      return true;
    });
    vi.spyOn(panels, 'back').mockImplementation(async () => {
      fixture.componentRef.setInput('view', DetailView.Info);
      return true;
    });
    return fixture;
  }

  async function open(
    chat: typeof wireChat & {
      mutedUntil?: string;
      myRole?: GroupRole;
      description?: string;
      speakingMode?: SpeakingMode;
    } = { ...wireChat },
  ) {
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne(`/_api/group/${wireChat.id}`).flush(chat);
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('keeps a management deep link while the group role loads, including a failed read and retry', async () => {
    TestBed.inject(ChatStore).remember([testChat]);
    const fixture = TestBed.createComponent(ChatDetails);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('view', DetailView.Management);
    fixture.detectChanges();
    expect(fixture.componentInstance['page']()).toBe(DetailView.Management);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    fixture.detectChanges();
    expect(fixture.componentInstance['page']()).toBe(DetailView.Management);
    expect(fixture.componentInstance['error']()).toBe(true);
    const retry = fixture.componentInstance['load']();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, myRole: GroupRole.admin });
    await retry;
    fixture.detectChanges();
    expect(fixture.componentInstance['canManage']()).toBe(true);
    expect(fixture.componentInstance['page']()).toBe(DetailView.Management);
    http.expectNone((request) => request.url.endsWith('/threads'));
  });

  it('returns a revoked management view to the overview in both the component and panel URL', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const path = `/chats/chat/${wireChat.id}/info`;
    fixture.componentRef.setInput('panelPath', path);
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    const replace = vi.spyOn(TestBed.inject(PanelNavigation), 'replacePage').mockResolvedValue(true);
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: testUser.uid,
        role: GroupRole.member,
        speakingMode: SpeakingMode.unrestricted,
        groupSpeakingMode: SpeakingMode.unrestricted,
        effectiveSpeakingMode: SpeakingMode.unrestricted,
      },
    });
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Info);
    expect(replace).toHaveBeenCalledExactlyOnceWith(path, DetailView.Info);
  });

  it('saves group visibility, disables changes while saving and restores the saved option after a failure', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    const save = component['saveMembershipVisibility'](MembershipMessageVisibility.admins);
    fixture.detectChanges();
    const selector = fixture.nativeElement.querySelector('ion-select');
    expect(selector.disabled).toBe(true);
    const request = http.expectOne(`/_api/group/${wireChat.id}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ membershipMessageVisibility: 'admins' });
    request.flush({
      ...wireChat,
      myRole: GroupRole.admin,
      membershipMessagePolicy: { visibility: 'admins', canView: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({
      ...wireChat,
      myRole: GroupRole.admin,
      membershipMessagePolicy: { visibility: 'admins', canView: true },
    });
    await save;
    fixture.detectChanges();
    expect(component['membershipVisibility']()).toBe(MembershipMessageVisibility.admins);
    const failing = component['saveMembershipVisibility'](MembershipMessageVisibility.nobody);
    http.expectOne(`/_api/group/${wireChat.id}`).flush({}, { status: 500, statusText: 'Failed' });
    await failing;
    fixture.detectChanges();
    expect(selector.value).toBe(MembershipMessageVisibility.admins);
    expect(selector.disabled).toBe(false);
  });

  it('keeps a newer policy received while a failed save is pending', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const saving = component['saveMembershipVisibility'](MembershipMessageVisibility.admins);
    TestBed.inject(ChatStore).acceptMembershipPolicy(testChat.id, {
      visibility: MembershipMessageVisibility.nobody,
      canView: false,
    });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({}, { status: 500, statusText: 'Failed' });
    await saving;
    expect(component['membershipVisibility']()).toBe(MembershipMessageVisibility.nobody);
  });

  it('shows the group policy without allowing ordinary members to change it', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.member });
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('全体成员');
    await fixture.componentInstance['saveMembershipVisibility'](MembershipMessageVisibility.nobody);
    http.expectNone((request) => request.method === 'PATCH');
  });

  it('saves group restrictions, restores failed selections and removes management on live demotion', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin, speakingMode: SpeakingMode.unrestricted });
    const component = fixture.componentInstance;
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-speaking-mode-select')).not.toBeNull();
    const saving = component['saveSpeakingMode'](SpeakingMode.readOnly);
    const request = http.expectOne(`/_api/group/${wireChat.id}/speaking-mode`);
    expect(request.request.body).toEqual({ speakingMode: 'readOnly' });
    request.flush({ chatId: wireChat.id, speakingMode: 'readOnly' });
    await saving;
    expect(component['speakingMode']()).toBe(SpeakingMode.readOnly);
    const failed = component['saveSpeakingMode'](SpeakingMode.unrestricted);
    http.expectOne(`/_api/group/${wireChat.id}/speaking-mode`).flush({}, { status: 403, statusText: 'Forbidden' });
    await failed;
    expect(component['speakingMode']()).toBe(SpeakingMode.readOnly);
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: testUser.uid,
        role: GroupRole.member,
        speakingMode: SpeakingMode.unrestricted,
        groupSpeakingMode: SpeakingMode.readOnly,
        effectiveSpeakingMode: SpeakingMode.readOnly,
      },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-speaking-mode-select')).toBeNull();
    await component['saveSpeakingMode'](SpeakingMode.unrestricted);
    http.expectNone((req) => req.method === 'PUT');
  });

  it('shows group management, invitations and leaving as direct actions', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const buttons = [...fixture.nativeElement.querySelectorAll('.quick-actions ion-button')];
    expect(buttons.map((button: Element) => button.textContent?.trim())).toEqual(['群管理', '邀请', '退群']);
    expect(fixture.nativeElement.querySelector('ion-popover')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('群管理');
    expect(fixture.nativeElement.querySelector('.field-edit, ion-select')).toBeNull();
  });

  it('keeps the selected content mounted and restores overview scroll when returning from management', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const content = component['overview']();
    const scroll = document.createElement('div');
    scroll.scrollTop = 246;
    vi.spyOn(content, 'getScrollElement').mockResolvedValue(scroll);
    const restore = vi.spyOn(content, 'scrollToPoint').mockResolvedValue();
    const threads = fixture.nativeElement.querySelector('app-chat-threads');
    const selected = component['tab']();
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-content').hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('app-chat-threads')).toBe(threads);
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('群管理');
    component['back']();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-content').hidden).toBe(false);
    expect(component['tab']()).toBe(selected);
    expect(fixture.nativeElement.querySelector('app-chat-threads')).toBe(threads);
    expect(restore).toHaveBeenCalledWith(0, 246, 0);
    http.expectNone((request) => request.url.endsWith('/messages'));
  });

  it('opens invitations from the overview and returns without stacking a modal', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const createModal = vi.spyOn(TestBed.inject(ModalController), 'create');
    const invite = [...fixture.nativeElement.querySelectorAll('.quick-actions ion-button')].find(
      (button: Element) => button.textContent?.trim() === '邀请',
    ) as HTMLElement;
    invite.click();
    await fixture.whenStable();
    fixture.detectChanges();
    http.match((request) => request.url.includes('/invites')).forEach((request) => request.flush({ invites: [] }));
    http.match((request) => request.url.endsWith('/group')).forEach((request) => request.flush({ groups: [] }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-invites')).not.toBeNull();
    expect(createModal).not.toHaveBeenCalled();
    component['back']();
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Info);
    expect(fixture.nativeElement.querySelector('app-chat-invites')).toBeNull();
  });

  it('ignores a pending panel entry after switching to a different chat', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    let resolve!: (element: HTMLElement) => void;
    vi.spyOn(component['overview'](), 'getScrollElement').mockReturnValue(new Promise((done) => (resolve = done)));
    const opening = component['openPage'](DetailView.Management);
    const nextId = encodeId('9007199254741993');
    fixture.componentRef.setInput('chatId', nextId);
    resolve(document.createElement('div'));
    await opening;
    expect(component['page']()).toBe(DetailView.Info);
    fixture.destroy();
  });

  it('has no chat-specific saved messages tab or menu entry', async () => {
    const fixture = await open();
    const previous = fixture.componentInstance['tab']();
    fixture.componentInstance['changeTab']('saved');
    fixture.detectChanges();
    expect(fixture.componentInstance['tab']()).toBe(previous);
    expect(fixture.nativeElement.textContent).not.toContain('本聊天收藏');
    expect(fixture.nativeElement.querySelector('app-saved-message-list')).toBeNull();
    http.expectNone((req) => req.url.includes('/saved-messages'));
  });

  it('keeps topics and members as tabs and opens media through list entries', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    const labels = () =>
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim());
    expect(labels()).toEqual(['话题', '成员']);
    expect(
      [...fixture.nativeElement.querySelectorAll('.media-links ion-item')].map((el: Element) => el.textContent?.trim()),
    ).toEqual(['图片', '视频', '文件']);
    http.expectNone((req) => req.url.endsWith('/attachments'));
    http.expectNone(
      (req) => req.url.endsWith('/members') || req.url.endsWith('/threads') || req.url.endsWith('/messages'),
    );
    component['changeTab']('members');
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === `/_api/group/${wireChat.id}/members`)
      .flush({ members: [], canManageMembers: false });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-members')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-chat-attachments')).toBeNull();
    component['changeTab']('threads');
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === `/_api/chats/${wireChat.id}/threads`)
      .flush({ threads: [{ ...wireMessage, threadInfo: { replyCount: 2 } }] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-threads').textContent).toContain('测试消息');
    const threads = fixture.nativeElement.querySelector('app-chat-threads');
    (fixture.nativeElement.querySelectorAll('.media-links ion-item')[1] as HTMLElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    http
      .expectOne((req) => req.url.endsWith('/attachments') && req.params.get('kind') === 'video')
      .flush({ attachments: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-segment')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('app-chat-threads')).toBe(threads);
    expect(fixture.nativeElement.querySelector('ion-title').textContent).toContain('视频');
    component['back']();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-threads')).toBe(threads);
    expect(fixture.nativeElement.querySelector('app-chat-attachments')).toBeNull();
    http.expectNone((req) => req.url.endsWith('/messages'));
  });

  it.each([
    [ChatAttachmentKindFilter.image, '图片'],
    [ChatAttachmentKindFilter.video, '视频'],
    [ChatAttachmentKindFilter.other, '文件'],
  ] as const)('loads %s only on entry and returns to the same members list after a retry', async (kind, title) => {
    const fixture = await open();
    const component = fixture.componentInstance;
    component['changeTab']('members');
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/members')).flush({ members: [], canManageMembers: false });
    await fixture.whenStable();
    const members = fixture.nativeElement.querySelector('app-chat-members');
    http.expectNone((req) => req.url.endsWith('/attachments'));
    const scroll = document.createElement('div');
    scroll.scrollTop = 180;
    vi.spyOn(component['overview'](), 'getScrollElement').mockResolvedValue(scroll);
    const restore = vi.spyOn(component['overview'](), 'scrollToPoint').mockResolvedValue();
    await component['openPage'](kind);
    fixture.detectChanges();
    const first = http.expectOne((req) => req.url.endsWith('/attachments'));
    expect(first.request.params.get('kind')).toBe(kind);
    first.flush({}, { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe(title);
    expect(fixture.nativeElement.querySelector('app-chat-members')).toBe(members);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-chat-attachments app-load-error ion-button')).not.toBeNull();
    });
    (fixture.nativeElement.querySelector('app-chat-attachments app-load-error ion-button') as HTMLElement).click();
    http
      .expectOne((req) => req.url.endsWith('/attachments') && req.params.get('kind') === kind)
      .flush({ attachments: [] });
    await fixture.whenStable();
    component['back']();
    await fixture.whenStable();
    expect(component['tab']()).toBe('members');
    expect(fixture.nativeElement.querySelector('app-chat-members')).toBe(members);
    expect(fixture.nativeElement.querySelector('app-chat-attachments')).toBeNull();
    expect(restore).toHaveBeenCalledWith(0, 180, 0);
    http.expectNone((req) => req.url.endsWith('/members') || req.url.endsWith('/attachments'));
  });

  it('cancels an unfinished media read when returning and opens the next category independently', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    await component['openPage'](ChatAttachmentKindFilter.image);
    fixture.detectChanges();
    const prior = http.expectOne((req) => req.url.endsWith('/attachments'));
    component['back']();
    fixture.detectChanges();
    expect(prior.cancelled).toBe(true);
    await component['openPage'](ChatAttachmentKindFilter.other);
    fixture.detectChanges();
    http
      .expectOne((req) => req.url.endsWith('/attachments') && req.params.get('kind') === 'other')
      .flush({ attachments: [] });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-title').textContent.trim()).toBe('文件');
    expect(fixture.nativeElement.querySelector('app-chat-attachments app-load-error')).toBeNull();
  });

  it('shows cached information and loads topics while details are still pending', async () => {
    const store = TestBed.inject(ChatStore);
    store.acceptChats([{ ...testChat, mutedUntil: '9999-12-31T23:59:59Z' }], store.snapshot());
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const details = http.expectOne(`/_api/group/${wireChat.id}`);
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    expect(fixture.componentInstance['chat']()).toBe(store.get(testChat.id));
    expect(fixture.componentInstance['busy']()).toBe(false);
    expect(fixture.nativeElement.querySelector('ion-content > .page-loading')).toBeNull();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    details.flush({ ...wireChat, description: '群介绍' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile p').textContent.trim()).toBe('群介绍');
  });

  it('reuses shared details when the panel is reopened', async () => {
    const first = await open();
    first.destroy();
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    http.expectNone(`/_api/group/${wireChat.id}`);
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('keeps cached information and media available after detail loading fails', async () => {
    TestBed.inject(ChatStore).remember([testChat]);
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    http.expectOne(`/_api/group/${wireChat.id}`).flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance['error']()).toBe(true));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testChat.name);
    expect(fixture.nativeElement.querySelector('app-chat-threads').textContent).toContain('暂无话题');
    expect(fixture.componentInstance['error']()).toBe(true);
    const retry = fixture.componentInstance['load']();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat });
    await retry;
    expect(fixture.componentInstance['error']()).toBe(false);
    http.expectNone((req) => req.url.endsWith('/threads'));
  });

  it('loads a known peer relationship in parallel without blocking the profile or media', async () => {
    const peer = { uid: 2, username: '朋友', gender: 0 };
    TestBed.inject(ChatStore).remember([{ ...testChat, kind: GroupKind.dm, peer }]);
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const details = http.expectOne(`/_api/group/${wireChat.id}`);
    await Promise.resolve();
    const relationship = http.expectOne('/_api/friends/2');
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe('朋友');
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    details.flush({ ...wireChat, kind: GroupKind.dm, peer });
    await vi.waitFor(() => expect(fixture.componentInstance['chat']()?.kind).toBe(GroupKind.dm));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-content > .page-loading')).toBeNull();
    relationship.flush({ peerUid: 2, isFriend: true });
    await vi.waitFor(() =>
      http.expectOne('/_api/friends/2/presence-settings').flush({ override: FriendPresenceOverride.inherit }),
    );
    http.expectOne('/_api/friends/2/read-receipt-settings').flush({ override: 'inherit' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-actions').textContent).toContain('解除好友');
    await fixture.componentInstance['openPage'](DetailView.Privacy);
    fixture.detectChanges();
    const selector: HTMLIonSelectElement = fixture.nativeElement.querySelector('ion-select');
    expect(selector.value).toBe(FriendPresenceOverride.inherit);
    selector.value = FriendPresenceOverride.hide;
    selector.dispatchEvent(new CustomEvent('ionChange', { detail: { value: FriendPresenceOverride.hide } }));
    const update = http.expectOne('/_api/friends/2/presence-settings');
    expect(update.request.method).toBe('PUT');
    expect(update.request.body).toEqual({ override: FriendPresenceOverride.hide });
    update.flush({ override: FriendPresenceOverride.hide });
    await fixture.whenStable();
    expect(presence.invalidateUsers).toHaveBeenCalledWith([2]);
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim()),
    ).toEqual([]);
    expect(fixture.nativeElement.querySelector('.attachments ion-list-header').textContent).toContain('话题');
  });

  it('shows an uncached profile before its friend relationship arrives', async () => {
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-content > .page-loading')).not.toBeNull();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, kind: GroupKind.dm, peer: { uid: 2, username: '朋友', gender: 0 } });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.profile h2')?.textContent.trim()).toBe('朋友');
    });
    expect(fixture.nativeElement.querySelector('ion-content > .page-loading')).toBeNull();
    http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true });
    await vi.waitFor(() =>
      http.expectOne('/_api/friends/2/presence-settings').flush({ override: FriendPresenceOverride.inherit }),
    );
    http.expectOne('/_api/friends/2/read-receipt-settings').flush({ override: 'inherit' });
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('keeps a directly opened privacy page through delayed relationship loading and retry', async () => {
    const fixture = createDetails();
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('user', { uid: 2, username: '朋友', gender: 0 });
    fixture.componentRef.setInput('view', DetailView.Privacy);
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Privacy);
    expect(fixture.nativeElement.querySelector('ion-list ion-spinner')).not.toBeNull();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({}, { status: 503, statusText: 'Unavailable' }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Privacy);
    const retry = fixture.nativeElement.querySelector(
      'ion-content:not([hidden]) app-load-error ion-button',
    ) as HTMLElement;
    expect(retry).not.toBeNull();
    retry.click();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true }));
    await vi.waitFor(() => http.expectOne('/_api/friends/2/presence-settings').flush({ override: 'share' }));
    http.expectOne('/_api/friends/2/read-receipt-settings').flush({ override: 'hide' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Privacy);
    expect(fixture.nativeElement.querySelectorAll('ion-select')).toHaveLength(2);
    const refresh = component['relationshipQuery']()!.refresh();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false }));
    await refresh;
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component['page']()).toBe(DetailView.Info);
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();
  });

  it('does not let a prior friend presence response overwrite the newly selected friend', async () => {
    const fixture = createDetails();
    fixture.componentRef.setInput('user', { uid: 2, username: '甲', gender: 0 });
    fixture.detectChanges();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true }));
    const prior = await vi.waitFor(() => http.expectOne('/_api/friends/2/presence-settings'));
    const priorReceipt = http.expectOne('/_api/friends/2/read-receipt-settings');

    fixture.componentRef.setInput('user', { uid: 3, username: '乙', gender: 0 });
    fixture.detectChanges();
    await vi.waitFor(() => http.expectOne('/_api/friends/3').flush({ peerUid: 3, isFriend: true }));
    const current = await vi.waitFor(() => http.expectOne('/_api/friends/3/presence-settings'));
    http.expectOne('/_api/friends/3/read-receipt-settings').flush({ override: 'share' });
    priorReceipt.flush({ override: 'hide' });
    current.flush({ override: FriendPresenceOverride.hide });
    prior.flush({ override: FriendPresenceOverride.inherit });
    await fixture.whenStable();
    fixture.detectChanges();

    await fixture.componentInstance['openPage'](DetailView.Privacy);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('ion-select') as HTMLIonSelectElement).value).toBe(
      FriendPresenceOverride.hide,
    );
    expect((fixture.nativeElement.querySelectorAll('ion-select')[1] as HTMLIonSelectElement).value).toBe('share');
  });

  it('keeps an open profile synchronized with exception edits and ignores older reads', async () => {
    const fixture = createDetails();
    fixture.componentRef.setInput('user', { uid: 2, username: '甲', gender: 0 });
    fixture.detectChanges();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true }));
    const prior = await vi.waitFor(() => http.expectOne('/_api/friends/2/presence-settings'));
    const receipt = http.expectOne('/_api/friends/2/read-receipt-settings');
    const store = TestBed.inject(ChatStore);
    store.publishPrivacyOverride(PrivacyExceptionKind.presence, 2, false);
    store.publishPrivacyOverride(PrivacyExceptionKind.readReceipts, 2, true);
    prior.flush({ override: 'inherit' });
    receipt.flush({ override: 'hide' });
    await fixture.whenStable();
    expect(fixture.componentInstance['presenceOverride']()).toBe('hide');
    expect(fixture.componentInstance['receiptOverride']()).toBe('share');
    store.publishPrivacyOverride(PrivacyExceptionKind.presence, 3, true);
    expect(fixture.componentInstance['presenceOverride']()).toBe('hide');
    store.publishPrivacyOverride(PrivacyExceptionKind.presence);
    store.publishPrivacyOverride(PrivacyExceptionKind.readReceipts);
    expect(fixture.componentInstance['presenceOverride']()).toBe('inherit');
    expect(fixture.componentInstance['receiptOverride']()).toBe('inherit');
  });

  it('keeps the newest chat when a previous detail request completes later', async () => {
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    const previous = http.expectOne(`/_api/group/${wireChat.id}`);
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    const nextId = encodeId('9007199254741993');
    fixture.componentRef.setInput('chatId', nextId);
    fixture.detectChanges();
    http.expectOne(`/_api/group/${decodeId(nextId)}`).flush({ ...wireChat, id: decodeId(nextId), name: '当前群' });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    previous.flush({ ...wireChat });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['chat']()?.name).toBe('当前群');
  });

  it('edits fields in place and saves only the chosen field, preserving another draft', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin, description: '原简介' });
    const component = fixture.componentInstance;
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    const { Name, Description } = component['Field'];
    expect(fixture.nativeElement.querySelectorAll('.field-edit')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.avatar-edit')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.group-editor')).not.toBeNull();
    component['edit'](Name);
    component['edit'](Description);
    fixture.detectChanges();
    const name = fixture.nativeElement.querySelector('input.profile-input') as HTMLInputElement;
    const description = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(name.value).toBe(wireChat.name);
    expect(description.value).toBe('原简介');
    name.value = '新群名';
    name.dispatchEvent(new Event('input'));
    description.value = '尚未保存的简介';
    description.dispatchEvent(new Event('input'));
    const saving = component['save'](Name);
    await component['save'](Name);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('h2 .field-edit ion-spinner')).not.toBeNull();
    const patch = http.expectOne({ method: 'PATCH', url: `/_api/group/${wireChat.id}` });
    expect(patch.request.body).toEqual({ name: '新群名' });
    patch.flush(null);
    await Promise.resolve();
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, name: '新群名', myRole: GroupRole.admin, description: '原简介' });
    await saving;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.group-editor h2').textContent.trim()).toBe('新群名');
    expect(fixture.nativeElement.querySelector('input.profile-input')).toBeNull();
    expect(description.value).toBe('尚未保存的简介');
    expect(component['edits']().description?.value).toBe('尚未保存的简介');
  });

  it('keeps a failed field open for retry and permits clearing the description', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin, description: '原简介' });
    const component = fixture.componentInstance;
    await component['openPage'](DetailView.Management);
    fixture.detectChanges();
    const field = component['Field'].Description;
    component['edit'](field);
    component['fields'].description!.value().value.set('');
    const saving = component['save'](field);
    const patch = http.expectOne({ method: 'PATCH', url: `/_api/group/${wireChat.id}` });
    expect(patch.request.body).toEqual({ description: '' });
    patch.flush({}, { status: 503, statusText: 'Unavailable' });
    await saving;
    expect(component['busy']()).toBe(false);
    expect(component['edits']().description?.value).toBe('');
    expect(IonToast.prototype.present).toHaveBeenCalled();
    const retry = component['save'](field);
    http.expectOne({ method: 'PATCH', url: `/_api/group/${wireChat.id}` }).flush(null);
    await Promise.resolve();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, myRole: GroupRole.admin, description: '' });
    await retry;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
    expect(fixture.nativeElement.querySelector('.group-editor p').textContent).toContain('添加群简介');
  });

  it('does not save an empty name or unchanged text and ignores Enter during composition', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const field = component['Field'].Name;
    component['edit'](field);
    await component['save'](field);
    expect(component['edits']().name).toBeUndefined();
    component['edit'](field);
    component['fields'].name!.value().value.set('   ');
    await component['save'](field);
    expect(component['edits']().name?.value).toBe('   ');
    component['fields'].name!.value().value.set('候选群名');
    component['editKeydown'](new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }), field);
    expect(component['edits']().name?.value).toBe('候选群名');
    component['editKeydown'](new KeyboardEvent('keydown', { key: 'Escape' }), field);
    expect(component['edits']().name).toBeUndefined();
    http.expectNone((req) => req.method === 'PATCH');
  });

  it.each([
    [GroupKind.group, GroupRole.member, false],
    [GroupKind.dm, GroupRole.admin, false],
    [GroupKind.group, GroupRole.admin, true],
  ])('does not allow editing for kind %s, role %s, topic %s', async (kind, myRole, thread) => {
    const fixture = await open({ ...wireChat, kind, myRole });
    const component = fixture.componentInstance;
    if (thread) {
      fixture.componentRef.setInput('threadId', testMessage.id);
      fixture.detectChanges();
      http
        .expectOne(
          (req) =>
            req.url === `/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/participants` &&
            req.params.get('limit') === '100',
        )
        .flush({ participants: [] });
      http
        .expectOne(`/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/subscribe`)
        .flush({ subscribed: false, archived: false });
    }
    fixture.detectChanges();
    component['edit'](component['Field'].Name);
    expect(component['canManage']()).toBe(false);
    expect(component['edits']().name).toBeUndefined();
    expect(fixture.nativeElement.querySelector('.field-edit')).toBeNull();
    expect(fixture.nativeElement.querySelector('.avatar-edit')).toBeNull();
  });

  it('refreshes the saved chat without closing a new chat field being edited', async () => {
    const fixture = await open({ ...wireChat, myRole: GroupRole.admin });
    const component = fixture.componentInstance;
    const field = component['Field'].Name;
    component['edit'](field);
    component['fields'].name!.value().value.set('旧群改名');
    const saving = component['save'](field);
    const patch = http.expectOne({ method: 'PATCH', url: `/_api/group/${wireChat.id}` });
    const nextId = encodeId('9007199254741993');
    fixture.componentRef.setInput('chatId', nextId);
    fixture.detectChanges();
    http
      .expectOne(`/_api/group/${decodeId(nextId)}`)
      .flush({ ...wireChat, id: decodeId(nextId), name: '当前群', myRole: GroupRole.admin });
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    await fixture.whenStable();
    component['edit'](field);
    expect(component['busy']()).toBe(false);
    patch.flush(null);
    await Promise.resolve();
    http.expectOne(`/_api/group/${wireChat.id}`).flush({ ...wireChat, name: '旧群改名', myRole: GroupRole.admin });
    await saving;
    expect(component['edits']().name?.value).toBe('当前群');
    expect(component['error']()).toBe(false);
  });

  it('does not navigate away when a leave request finishes after the panel was closed', async () => {
    const fixture = await open();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    alert.onDidDismiss.mockResolvedValue({ role: 'confirm' });
    const leaving = fixture.componentInstance['leave']();
    await vi.waitFor(() => expect(fixture.componentInstance['busy']()).toBe(true));
    const request = http.expectOne((req) => req.method === 'DELETE');
    fixture.destroy();
    request.flush(null);
    await leaving;
    expect(TestBed.inject(ChatListStore).refreshChats).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes the panel flow when the close button is tapped', async () => {
    const fixture = await open();
    fixture.detectChanges();
    const dismiss = vi.spyOn(TestBed.inject(PanelNavigation), 'close').mockResolvedValue(true);
    (fixture.nativeElement.querySelector('.close-button') as HTMLElement).click();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('offers a separate return to the source when the profile has parent panels', async () => {
    const panels = TestBed.inject(PanelNavigation);
    const paths = signal<string[]>([]);
    vi.spyOn(panels, 'paths').mockImplementation(paths);
    const fixture = await open();
    expect(fixture.nativeElement.querySelector('.back-button')).toBeNull();
    paths.set(['/settings', '/profile/2']);
    fixture.detectChanges();
    const close = vi.spyOn(panels, 'close');
    (fixture.nativeElement.querySelector('.back-button') as HTMLElement).click();
    expect(panels.back).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('shows thread details and switches one action from subscription to archive and unarchive', async () => {
    const fixture = await open();
    expect(fixture.nativeElement.querySelector('.quick-actions')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('退群');
    fixture.componentRef.setInput('threadId', testMessage.id);
    fixture.componentRef.setInput('threadRoot', testMessage);
    fixture.detectChanges();
    http
      .expectOne(
        (req) =>
          req.url === `/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/participants` &&
          req.params.get('limit') === '100',
      )
      .flush({ participants: [testMessage.sender] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim()),
    ).toEqual([]);
    expect(fixture.nativeElement.querySelector('.attachments ion-list-header').textContent).toContain('成员');
    expect(fixture.nativeElement.querySelector('app-thread-participants').textContent).toContain(
      testMessage.sender.name,
    );
    http.expectNone(
      (req) => req.url.endsWith('/members') || req.url.endsWith('/attachments') || req.url.includes('/saved-messages'),
    );
    expect(fixture.nativeElement.querySelector('.profile h2').textContent.trim()).toBe(testMessage.message);
    http
      .expectOne(`/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/subscribe`)
      .flush({ subscribed: false, archived: false });
    await fixture.whenStable();
    fixture.detectChanges();
    const buttons = () => [...fixture.nativeElement.querySelectorAll('.quick-actions ion-button')] as HTMLElement[];
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['订阅']);
    expect(buttons()[0].querySelector('ion-icon')?.icon).toBe(notificationsOutline);
    expect(fixture.nativeElement.querySelector('.profile p').textContent.trim()).toBe(`${testChat.name} 中的话题`);
    for (const [method, endpoint, label, icon] of [
      ['PUT', 'subscribe', '归档', archiveOutline],
      ['PUT', 'archive', '已归档', archive],
      ['DELETE', 'archive', '归档', archiveOutline],
    ]) {
      buttons()[0].click();
      fixture.detectChanges();
      expect(buttons()[0].querySelector('ion-spinner')).toBeNull();
      expect(buttons()[0].textContent?.trim()).toBe(label);
      const write = http.expectOne({
        method,
        url: `/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/${endpoint}`,
      });
      // The membership push can arrive before the write response.
      events.next({
        type: ServerWsMessageType.threadMembershipChanged,
        payload: { chatId: testChat.id, threadRootId: testMessage.id },
      });
      await fixture.whenStable();
      fixture.detectChanges();
      const refresh = http.expectOne({
        method: 'GET',
        url: `/_api/chats/${wireChat.id}/threads/${decodeId(testMessage.id)}/subscribe`,
      });
      const loadingLabel = buttons()[0].textContent?.trim();
      refresh.flush({ subscribed: true, archived: label === '已归档' });
      await fixture.whenStable();
      write.flush(null);
      expect(loadingLabel).toBe(label);
      await fixture.whenStable();
      fixture.detectChanges();
      expect(buttons().map((button) => button.textContent?.trim())).toEqual([label]);
      await vi.waitFor(() => expect(buttons()[0].querySelector('ion-icon')?.icon).toBe(icon));
    }
    expect(fixture.nativeElement.querySelector('.avatar-badge').textContent.trim()).toBe('测');
    expect(fixture.nativeElement.querySelector('app-chat-avatar').style.getPropertyValue('--avatar-size')).toBe('88px');
  });

  it('deletes a confirmed friend through the friend endpoint, not the group member endpoint', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = createDetails();
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.detectChanges();
    http
      .expectOne(`/_api/group/${wireChat.id}`)
      .flush({ ...wireChat, kind: GroupKind.dm, peer: { uid: 2, username: '朋友', gender: 0 } });
    await Promise.resolve();
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: true }));
    await vi.waitFor(() =>
      http.expectOne('/_api/friends/2/presence-settings').flush({ override: FriendPresenceOverride.inherit }),
    );
    http.expectOne('/_api/friends/2/read-receipt-settings').flush({ override: 'inherit' });
    await Promise.resolve();
    fixture.detectChanges();
    http.expectOne((req) => req.url.endsWith('/threads')).flush({ threads: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    const actions = () =>
      [...fixture.nativeElement.querySelectorAll('.quick-actions ion-button')].map((button: Element) =>
        button.textContent?.trim(),
      );
    expect(actions()).toEqual(['个人空间', '发消息', '解除好友', '拉黑']);
    fixture.componentRef.setInput('currentConversation', true);
    fixture.detectChanges();
    expect(actions()).toEqual(['个人空间', '解除好友', '拉黑']);

    await fixture.componentInstance['openPage'](DetailView.Privacy);
    fixture.detectChanges();
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment-button')].map((el: Element) => el.textContent?.trim()),
    ).toEqual([]);
    expect(fixture.nativeElement.querySelector('.attachments ion-list-header').textContent).toContain('话题');
    alert.onDidDismiss.mockResolvedValue({ role: 'confirm' });
    const deleting = fixture.componentInstance['leave']();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne({ method: 'DELETE', url: '/_api/friends/2' }).flush(null);
    await vi.waitFor(() => http.expectOne('/_api/friends/2').flush({ peerUid: 2, isFriend: false }));
    await deleting;
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-select')).toBeNull();
    http.expectNone('/_api/friends/2/presence-settings');
    expect(navigate).toHaveBeenCalledWith(['/chats']);
    expect(fixture.componentInstance['error']()).toBe(false);
  });

  it('does not leave a group when the confirmation is cancelled', async () => {
    const fixture = await open();
    alert.onDidDismiss.mockResolvedValue({ role: 'cancel' });
    await fixture.componentInstance['leave']();
    http.expectNone((req) => req.method === 'DELETE');
    expect(fixture.componentInstance['busy']()).toBe(false);
  });
});
