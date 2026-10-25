import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupRole, ServerWsMessageType, SpeakingMode, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { mockRealtime, testChat, testUser, wireChat } from '../../api/testing';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { SessionStore } from '../../session/session-store';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { SpeakingAction } from '../speaking';
import { StartChat, StartChatKind } from './start-chat';

describe('StartChat membership permissions', () => {
  let http: HttpTestingController;
  let store: ChatStore;
  let events: Subject<ServerWsMessage>;
  const navigate = vi.fn().mockResolvedValue(true);
  const details = {
    ...wireChat,
    myRole: GroupRole.member,
    speakingMode: SpeakingMode.unrestricted,
    mySpeakingMode: SpeakingMode.unrestricted,
  };
  const url = `/_api/group/${wireChat.id}`;

  beforeEach(() => {
    events = new Subject();
    navigate.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: ConversationNavigation, useValue: { open: navigate } },
        { provide: ChatListStore, useValue: { refreshChats: () => store.invalidateReads() } },
      ],
    });
    TestBed.overrideComponent(StartChat, { set: { template: '' } });
    store = TestBed.inject(ChatStore);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function invite(alreadyMember = false) {
    const fixture = TestBed.createComponent(StartChat);
    fixture.componentRef.setInput('kind', StartChatKind.Join);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component['values'].set({ name: '', code: 'join-code' });
    const lookup = component['lookup']();
    http
      .expectOne((request) => request.url.endsWith('/invites/invite'))
      .flush({
        alreadyMember,
        chat: details,
        invite: { id: '100', chatId: wireChat.id, code: 'join-code', inviteType: 'generic', createdAt: '' },
      });
    await lookup;
    return component;
  }

  async function restrict() {
    const loading = store.ensureDetails(testChat.id);
    http.expectOne(url).flush({ ...details, mySpeakingMode: SpeakingMode.readOnly });
    await loading;
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
  }

  it('replaces the previous membership restriction on rejoin without another detail request', async () => {
    await restrict();
    const component = await invite();
    const joining = component['submit']();
    http.expectOne('/_api/invites/redeem').flush({ chat: details });
    await joining;
    await store.ensureDetails(testChat.id);
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(true);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(testChat.id);
    http.expectNone(url);
  });

  it('does not restore the old membership from a detail read pending before rejoin', async () => {
    await restrict();
    const component = await invite();
    store.invalidate();
    const loading = store.ensureDetails(testChat.id);
    const oldDetails = http.expectOne(url);
    const joining = component['submit']();
    http.expectOne('/_api/invites/redeem').flush({ chat: details });
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
    http.expectOne('/_api/invites/redeem').flush({ chat: details });
    await joining;
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
    await store.ensureDetails(testChat.id);
    http.expectNone(url);
  });

  it('does not replace current permissions with an already-member invite preview', async () => {
    await restrict();
    const component = await invite(true);
    await component['submit']();
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
    http.expectNone('/_api/invites/redeem');
  });

  it('discards the joined state and navigation after an account switch', async () => {
    const component = await invite();
    const joining = component['submit']();
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    http.expectOne('/_api/invites/redeem').flush({ chat: details });
    await joining;
    expect(store.get(testChat.id)).toBeUndefined();
    expect(navigate).not.toHaveBeenCalled();
  });
});
