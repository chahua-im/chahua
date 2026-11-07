import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { GroupRole, ServerWsMessageType, SpeakingMode, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { mockRealtime, testChat, testUser, wireChat } from '../../api/testing';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { SpeakingAction } from '../speaking';
import { StartChat, StartChatKind } from './start-chat';

describe('StartChat', () => {
  let peer: RpcTestPeer;
  let store: ChatStore;
  let events: Subject<ServerWsMessage>;
  const navigate = vi.fn().mockResolvedValue(true);
  const details = {
    ...wireChat,
    myRole: GroupRole.member,
    speakingMode: SpeakingMode.unrestricted,
    mySpeakingMode: SpeakingMode.unrestricted,
  };
  const detailParams = { chatId: wireChat.id };

  beforeEach(() => {
    events = new Subject();
    navigate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ events$: events }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ConversationNavigation, useValue: { open: navigate } },
        { provide: ChatListStore, useValue: { refreshChats: () => store.invalidateReads() } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    store = TestBed.inject(ChatStore);
  });
  afterEach(() => peer.verify());

  async function invite(alreadyMember = false) {
    const fixture = TestBed.createComponent(StartChat);
    fixture.componentRef.setInput('kind', StartChatKind.Join);
    fixture.componentRef.setInput('code', 'join-code');
    fixture.detectChanges();
    const component = fixture.componentInstance;
    peer.expect('invites.getByCode', { inviteCode: 'join-code' }).flush({
      alreadyMember,
      canJoin: !alreadyMember,
      chat: details,
      invite: { id: '100', chatId: wireChat.id, code: 'join-code', inviteType: 'generic', createdAt: '' },
    });
    return component;
  }

  function preview(code = 'join-code') {
    return {
      alreadyMember: false,
      canJoin: true,
      chat: details,
      invite: { id: '100', chatId: wireChat.id, code, inviteType: 'generic', createdAt: '' },
    };
  }

  function join(code?: string) {
    const fixture = TestBed.createComponent(StartChat);
    fixture.componentRef.setInput('kind', StartChatKind.Join);
    if (code) fixture.componentRef.setInput('code', code);
    fixture.detectChanges();
    return fixture;
  }

  it('shows details immediately when opened from an invitation card or link', () => {
    const fixture = join('join-code');
    expect(fixture.nativeElement.querySelector('ion-skeleton-text')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    peer.expect('invites.getByCode', { inviteCode: 'join-code' }).flush(preview());
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(details.name);
    expect(fixture.nativeElement.textContent).not.toContain('查看邀请');
    peer.expectNone('invites.redeem');
  });

  it.each(['join-code', 'https://example.com/chats/join/join-code'])(
    'automatically previews a pasted code or link: %s',
    async (value) => {
      const fixture = join();
      peer.expectNone('invites.getByCode');
      const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      (await peer.expectAsync('invites.getByCode', { inviteCode: 'join-code' })).flush(preview());
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(details.name);
      expect(fixture.nativeElement.textContent).not.toContain('查看邀请');
      expect(fixture.componentInstance['previewValid']()).toBe(true);
      peer.expectNone('invites.redeem');
    },
  );

  it('discards late previews after editing or clearing the code', async () => {
    const fixture = join();
    const component = fixture.componentInstance;
    component['values'].update((value) => ({ ...value, code: 'old-code' }));
    fixture.detectChanges();
    const old = await peer.expectAsync('invites.getByCode', { inviteCode: 'old-code' });
    component['values'].update((value) => ({ ...value, code: 'new-code' }));
    fixture.detectChanges();
    const current = await peer.expectAsync('invites.getByCode', { inviteCode: 'new-code' });
    old.flush(preview('old-code'));
    expect(component['preview']()).toBeUndefined();
    expect(component['previewValid']()).toBe(false);
    component['values'].update((value) => ({ ...value, code: '' }));
    fixture.detectChanges();
    current.flush(preview('new-code'));
    expect(component['preview']()).toBeUndefined();
    expect(component['busy']()).toBe(false);
  });

  it('allows retrying an automatic preview that failed', () => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').error(-32603);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    fixture.nativeElement.querySelector('app-load-error ion-button').click();
    fixture.detectChanges();
    peer.expect('invites.getByCode', { inviteCode: 'join-code' }).flush(preview());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
    expect(fixture.componentInstance['previewValid']()).toBe(true);
  });

  it.each([
    [RpcErrorCode.BadRequest, '无效的邀请码'],
    [RpcErrorCode.NotFound, '邀请不存在'],
    [RpcErrorCode.Gone, '邀请已过期'],
    [RpcErrorCode.Forbidden, '无法使用此邀请'],
  ])('explains unavailable invites without retry or join actions (%s)', (code, message) => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').error(code);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(message);
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
    expect(fixture.nativeElement.querySelector('.invite-submit')).toBeNull();
    expect(fixture.componentInstance['previewValid']()).toBe(false);
    peer.expectNone('invites.redeem');
  });

  it('clears an unavailable explanation when opening a valid invitation', () => {
    const fixture = join('old-code');
    peer.expect('invites.getByCode').error(RpcErrorCode.Gone);
    fixture.detectChanges();
    fixture.componentRef.setInput('code', 'join-code');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('邀请已过期');
    peer.expect('invites.getByCode', { inviteCode: 'join-code' }).flush(preview());
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(details.name);
    expect(fixture.componentInstance['previewValid']()).toBe(true);
    expect(fixture.nativeElement.querySelector('.invite-submit')).not.toBeNull();
  });

  it('replaces a preview with an explanation when the invite becomes invalid before joining', async () => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').flush(preview());
    const joining = fixture.componentInstance['submit']();
    peer.expect('invites.redeem').error(RpcErrorCode.Gone);
    await joining;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('邀请已过期');
    expect(fixture.nativeElement.querySelector('.invite-submit')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows group details with a disabled not-invited button and never attempts to join', async () => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').flush({ ...preview(), canJoin: false });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(details.name);
    const button = fixture.nativeElement.querySelector('.invite-submit');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('未受邀');
    await fixture.componentInstance['submit']();
    peer.expectNone('invites.redeem');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refreshes eligibility after a join is rejected without hiding the known group profile', async () => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').flush(preview());
    fixture.detectChanges();
    const joining = fixture.componentInstance['submit']();
    peer.expect('invites.redeem').error(RpcErrorCode.Forbidden);
    const refresh = await peer.expectAsync('invites.getByCode');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(details.name);
    expect(fixture.nativeElement.querySelector('ion-skeleton-text')).toBeNull();
    refresh.flush({ ...preview(), canJoin: false });
    await joining;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.invite-submit').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('未受邀');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores an eligibility refresh after opening a different invitation', async () => {
    const fixture = join('join-code');
    peer.expect('invites.getByCode').flush(preview());
    const joining = fixture.componentInstance['submit']();
    peer.expect('invites.redeem').error(RpcErrorCode.Forbidden);
    const refresh = await peer.expectAsync('invites.getByCode');
    fixture.componentRef.setInput('code', 'new-code');
    fixture.detectChanges();
    const current = peer.expect('invites.getByCode', { inviteCode: 'new-code' });
    refresh.flush({ ...preview(), canJoin: false });
    await joining;
    fixture.detectChanges();
    expect(fixture.componentInstance['preview']()).toBeUndefined();
    expect(fixture.nativeElement.querySelector('ion-skeleton-text')).not.toBeNull();
    current.flush(preview('new-code'));
    fixture.detectChanges();
    expect(fixture.componentInstance['previewValid']()).toBe(true);
  });

  it('keeps a used targeted invite visible while disabling repeat redemption', async () => {
    const fixture = join('join-code');
    const value = preview();
    peer.expect('invites.getByCode').flush({
      ...value,
      canJoin: false,
      invite: { ...value.invite, inviteType: 'targeted', targetUid: testUser.uid, usedAt: '2026-01-01T00:00:00Z' },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(details.name);
    const button = fixture.nativeElement.querySelector('.invite-submit');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('邀请已使用');
    await fixture.componentInstance['submit']();
    peer.expectNone('invites.redeem');
  });

  it('discards an automatic preview after signing out', () => {
    const fixture = join('join-code');
    const request = peer.expect('invites.getByCode');
    TestBed.inject(SessionStore).user.set(undefined);
    fixture.detectChanges();
    request.flush(preview());
    expect(fixture.componentInstance['preview']()).toBeUndefined();
    expect(fixture.componentInstance['previewValid']()).toBe(false);
    peer.expectNone('invites.getByCode');
  });

  async function restrict() {
    const loading = store.ensureDetails(testChat.id);
    peer.expect('groups.get', detailParams).flush({ ...details, mySpeakingMode: SpeakingMode.readOnly });
    await loading;
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
  }

  it('replaces the previous membership restriction on rejoin without another detail request', async () => {
    await restrict();
    const component = await invite();
    const joining = component['submit']();
    peer.expect('invites.redeem', { code: 'join-code' }).flush({ chat: details });
    await joining;
    await store.ensureDetails(testChat.id);
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(testChat.id);
    peer.expectNone('groups.get');
  });

  it('does not restore the old membership from a detail read pending before rejoin', async () => {
    await restrict();
    const component = await invite();
    store.invalidate();
    const loading = store.ensureDetails(testChat.id);
    const oldDetails = peer.expect('groups.get', detailParams);
    const joining = component['submit']();
    peer.expect('invites.redeem', { code: 'join-code' }).flush({ chat: details });
    await joining;
    oldDetails.flush({ ...details, mySpeakingMode: SpeakingMode.readOnly });
    await loading;
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(true);
  });

  it('preserves restrictions received after the rejoin request started', async () => {
    const component = await invite();
    const joining = component['submit']();
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: testUser.uid,
        role: GroupRole.member,
        speakingMode: SpeakingMode.readOnly,
        groupSpeakingMode: SpeakingMode.unrestricted,
        effectiveSpeakingMode: SpeakingMode.readOnly,
      },
    });
    peer.expect('invites.redeem', { code: 'join-code' }).flush({ chat: details });
    await joining;
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
    await store.ensureDetails(testChat.id);
    peer.expectNone('groups.get');
  });

  it('does not replace current permissions with an already-member invite preview', async () => {
    await restrict();
    const component = await invite(true);
    await component['submit']();
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    peer.expectNone('invites.redeem');
  });

  it('discards the joined state and navigation after an account switch', async () => {
    const component = await invite();
    const joining = component['submit']();
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    peer.expect('invites.redeem', { code: 'join-code' }).flush({ chat: details });
    await joining;
    expect(store.get(testChat.id)).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });
});
