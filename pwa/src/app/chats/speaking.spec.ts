import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupRole, ServerWsMessageType, SpeakingMode, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { mockRealtime, testChat, testUser, wireChat } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { ChatStore } from './chat-store';
import { allowsSpeaking, effectiveSpeakingMode, SpeakingAction, speakingErrorMode } from './speaking';

describe('speaking permissions', () => {
  it('intersects group and member permissions for main chat, new threads and existing replies', () => {
    const cases = [
      { mode: SpeakingMode.unrestricted, allowed: [true, true, true] },
      { mode: SpeakingMode.threadsOnly, allowed: [false, true, true] },
      { mode: SpeakingMode.repliesOnly, allowed: [false, false, true] },
      { mode: SpeakingMode.readOnly, allowed: [false, false, false] },
    ];
    const actions = [SpeakingAction.ChatMessage, SpeakingAction.CreateThread, SpeakingAction.ThreadReply];
    for (const group of cases)
      for (const member of cases) {
        const mode = effectiveSpeakingMode(GroupRole.member, group.mode, member.mode);
        actions.forEach((action, index) =>
          expect(allowsSpeaking(mode, action)).toBe(group.allowed[index] && member.allowed[index]),
        );
        expect(effectiveSpeakingMode(GroupRole.admin, group.mode, member.mode)).toBe(SpeakingMode.unrestricted);
      }
  });

  it('recognizes only the structured speaking restriction, not unrelated authorization errors', () => {
    const error = (body: unknown, status = 403) => new HttpErrorResponse({ status, error: body });
    expect(speakingErrorMode(error({ code: 'speakingRestricted', effectiveSpeakingMode: 'readOnly' }))).toBe(
      SpeakingMode.readOnly,
    );
    expect(speakingErrorMode(error('Forbidden'))).toBeUndefined();
    expect(speakingErrorMode(error({ code: 'speakingRestricted', effectiveSpeakingMode: 'unknown' }))).toBeUndefined();
    expect(
      speakingErrorMode(error({ code: 'speakingRestricted', effectiveSpeakingMode: 'readOnly' }, 500)),
    ).toBeUndefined();
  });
});

describe('speaking state synchronization', () => {
  let store: ChatStore;
  let http: HttpTestingController;
  let events: Subject<ServerWsMessage>;
  const url = `/_api/group/${wireChat.id}`;
  const details = {
    ...wireChat,
    myRole: GroupRole.member,
    speakingMode: SpeakingMode.unrestricted,
    mySpeakingMode: SpeakingMode.unrestricted,
  };

  beforeEach(() => {
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
      ],
    });
    store = TestBed.inject(ChatStore);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function load() {
    const request = store.ensureDetails(testChat.id);
    http.expectOne(url).flush(details);
    await request;
  }
  function group(mode: SpeakingMode) {
    events.next({
      type: ServerWsMessageType.groupSpeakingModeChanged,
      payload: { chatId: testChat.id, speakingMode: mode },
    });
  }
  function member(role: GroupRole, mode: SpeakingMode) {
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: testUser.uid,
        role,
        speakingMode: mode,
        groupSpeakingMode: SpeakingMode.threadsOnly,
        effectiveSpeakingMode: role === GroupRole.admin ? SpeakingMode.unrestricted : mode,
      },
    });
  }

  it('applies live restrictions before details arrive and rejects the stale snapshot', async () => {
    const pending = store.ensureDetails(testChat.id);
    member(GroupRole.member, SpeakingMode.readOnly);
    http.expectOne(url).flush(details);
    await pending;
    expect(store.get(testChat.id)?.mySpeakingMode).toBe(SpeakingMode.readOnly);
    expect(store.canSpeak(testChat.id, SpeakingAction.ThreadReply)).toBe(false);
    http.expectNone(() => true);
  });

  it('updates group and personal modes independently and applies promotion and demotion immediately', async () => {
    await load();
    member(GroupRole.member, SpeakingMode.readOnly);
    group(SpeakingMode.unrestricted);
    expect(store.canSpeak(testChat.id, SpeakingAction.ThreadReply)).toBe(false);
    member(GroupRole.admin, SpeakingMode.unrestricted);
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.admin);
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(true);
    member(GroupRole.member, SpeakingMode.unrestricted);
    expect(store.canSpeak(testChat.id, SpeakingAction.ChatMessage)).toBe(false);
    expect(store.canSpeak(testChat.id, SpeakingAction.CreateThread)).toBe(true);
    http.expectNone(() => true);
  });

  it('does not let a detail read started during a save restore the previous group mode', async () => {
    await load();
    const saving = store.setSpeakingMode(testChat.id, SpeakingMode.readOnly);
    const write = http.expectOne(`${url}/speaking-mode`);
    expect(write.request.body).toEqual({ speakingMode: 'readOnly' });
    store.invalidate();
    const reading = store.ensureDetails(testChat.id);
    const read = http.expectOne(url);
    write.flush({ chatId: wireChat.id, speakingMode: 'readOnly' });
    await saving;
    read.flush(details);
    await reading;
    expect(store.speakingMode(testChat.id)).toBe(SpeakingMode.readOnly);
  });

  it('preserves a newer WS snapshot when a saved response arrives late', async () => {
    await load();
    const saving = store.setSpeakingMode(testChat.id, SpeakingMode.readOnly);
    group(SpeakingMode.repliesOnly);
    http.expectOne(`${url}/speaking-mode`).flush({ chatId: wireChat.id, speakingMode: 'readOnly' });
    await saving;
    expect(store.speakingMode(testChat.id)).toBe(SpeakingMode.repliesOnly);
  });

  it('keeps known permissions after a failed save and clears them on account change', async () => {
    await load();
    group(SpeakingMode.threadsOnly);
    const saving = store.setSpeakingMode(testChat.id, SpeakingMode.readOnly);
    const rejected = expect(saving).rejects.toBeDefined();
    http.expectOne(`${url}/speaking-mode`).flush({}, { status: 403, statusText: 'Forbidden' });
    await rejected;
    expect(store.speakingMode(testChat.id)).toBe(SpeakingMode.threadsOnly);
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    expect(store.get(testChat.id)).toBeUndefined();
    expect(store.speakingMode(testChat.id)).toBeUndefined();
  });
});
