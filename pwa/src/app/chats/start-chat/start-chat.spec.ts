import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { GroupRole, ServerWsMessageType, SpeakingMode, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { mockRealtime, testChat, testUser, wireChat } from '../../api/testing';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { SpeakingAction } from '../speaking';
import { StartChat, StartChatKind } from './start-chat';

describe('StartChat membership permissions', () => {
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
    TestBed.overrideComponent(StartChat, { set: { template: '' } });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    store = TestBed.inject(ChatStore);
  });
  afterEach(() => peer.verify());

  async function invite(alreadyMember = false) {
    const fixture = TestBed.createComponent(StartChat);
    fixture.componentRef.setInput('kind', StartChatKind.Join);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component['values'].set({ name: '', code: 'join-code' });
    const lookup = component['lookup']();
    peer.expect('invites.getByCode', { inviteCode: 'join-code' }).flush({
      alreadyMember,
      chat: details,
      invite: { id: '100', chatId: wireChat.id, code: 'join-code', inviteType: 'generic', createdAt: '' },
    });
    await lookup;
    return component;
  }

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
