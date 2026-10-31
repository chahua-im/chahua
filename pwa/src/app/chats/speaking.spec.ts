import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { GroupRole, ServerWsMessageType, SpeakingMode, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { RpcError, RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
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
    expect(
      speakingErrorMode(
        new RpcError(RpcErrorCode.SpeakingRestricted, 'Speaking is restricted', {
          effectiveSpeakingMode: 'readOnly',
        }),
      ),
    ).toBe(SpeakingMode.readOnly);
    expect(speakingErrorMode(new RpcError(RpcErrorCode.Forbidden, 'Forbidden'))).toBeUndefined();
    expect(
      speakingErrorMode(
        new RpcError(RpcErrorCode.SpeakingRestricted, 'Speaking is restricted', { effectiveSpeakingMode: 'unknown' }),
      ),
    ).toBeUndefined();
    expect(
      speakingErrorMode(new RpcError(RpcErrorCode.Internal, 'Internal', { effectiveSpeakingMode: 'readOnly' })),
    ).toBeUndefined();
  });
});

describe('speaking state synchronization', () => {
  let store: ChatStore;
  let peer: RpcTestPeer;
  let events: Subject<ServerWsMessage>;
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
        provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ events$: events }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    store = TestBed.inject(ChatStore);
  });
  afterEach(() => peer.verify());

  async function load() {
    const request = store.ensureDetails(testChat.id);
    peer.expect('groups.get', { chatId: wireChat.id }).flush(details);
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
    peer.expect('groups.get', { chatId: wireChat.id }).flush(details);
    await pending;
    expect(store.get(testChat.id)?.mySpeakingMode).toBe(SpeakingMode.readOnly);
    expect(store.canSpeak(testChat.id, SpeakingAction.ThreadReply)).toBe(false);
    peer.expectNone('groups.get');
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
    peer.expectNone('groups.get');
  });

  it('does not let a detail read started during a save restore the previous group mode', async () => {
    await load();
    const saving = store.setSpeakingMode(testChat.id, SpeakingMode.readOnly);
    const write = peer.expect('groups.updateSpeakingMode', {
      chatId: wireChat.id,
      speakingMode: SpeakingMode.readOnly,
    });
    store.invalidate();
    const reading = store.ensureDetails(testChat.id);
    const read = peer.expect('groups.get', { chatId: wireChat.id });
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
    peer.expect('groups.updateSpeakingMode', { chatId: wireChat.id, speakingMode: SpeakingMode.readOnly }).flush({
      chatId: wireChat.id,
      speakingMode: 'readOnly',
    });
    await saving;
    expect(store.speakingMode(testChat.id)).toBe(SpeakingMode.repliesOnly);
  });

  it('keeps known permissions after a failed save and clears them on account change', async () => {
    await load();
    group(SpeakingMode.threadsOnly);
    const saving = store.setSpeakingMode(testChat.id, SpeakingMode.readOnly);
    const rejected = expect(saving).rejects.toBeDefined();
    peer
      .expect('groups.updateSpeakingMode', { chatId: wireChat.id, speakingMode: SpeakingMode.readOnly })
      .error(RpcErrorCode.Forbidden);
    await rejected;
    expect(store.speakingMode(testChat.id)).toBe(SpeakingMode.threadsOnly);
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    expect(store.get(testChat.id)).toBeUndefined();
    expect(store.speakingMode(testChat.id)).toBeUndefined();
  });
});
