import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { GroupKind } from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { Connection } from '../../api/connection';
import { mockRealtime, testChat, testUser } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { ChatStore } from '../../chats/chat-store';
import { ChatListStore } from '../../chats/chat-list-store';
import { NotificationExceptionPicker } from './notification-exception-picker';

describe('notification exception picker', () => {
  function setup(kind = GroupKind.group, muted = true) {
    const release = vi.fn();
    const active = { items: signal([{ ...testChat, kind, muteOverride: undefined }]), activate: () => release };
    const archived = { items: signal([{ ...testChat, kind, archived: true }]), activate: () => release };
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime() },
        { provide: ChatListStore, useValue: { chats: (archive: boolean) => (archive ? archived : active) } },
      ],
    });
    const peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    TestBed.inject(SessionStore).user.set({
      ...testUser,
      muteGroupChatsByDefault: muted,
      muteDirectChatsByDefault: muted,
    });
    const store = TestBed.inject(ChatStore);
    store.acceptChats([{ ...testChat, kind, archived: true }], store.snapshot());
    const fixture = TestBed.createComponent(NotificationExceptionPicker);
    fixture.componentRef.setInput('kind', kind);
    return { fixture, component: fixture.componentInstance, peer, store, release };
  }

  it.each([
    [GroupKind.group, true, 'alwaysUnmuted'],
    [GroupKind.dm, false, 'alwaysMuted'],
  ] as const)('adds a %s exception opposite to default without unarchiving', async (kind, muted, mode) => {
    const { fixture, component, peer, store, release } = setup(kind, muted);
    expect(component['targets']()).toHaveLength(1);
    const saving = component['select'](testChat.id);
    peer.expect('groups.updateNotificationSetting', { chatId: '9007199254740993', mode }).flush({
      chatId: '9007199254740993',
      kind,
      archived: true,
      muteOverride: !muted,
      mutedUntil: null,
      isMuted: !muted,
    });
    await saving;
    expect(component['open']()).toBe(false);
    expect(store.chatState(testChat.id)?.archived).toBe(true);
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(2);
    peer.verify();
  });

  it('retains the picker and restores preferences after a failed add', async () => {
    const { fixture, component, peer, store } = setup();
    const before = store.chatState(testChat.id)?.muteOverride;
    const saving = component['select'](testChat.id);
    peer
      .expect('groups.updateNotificationSetting', {
        chatId: '9007199254740993',
        mode: 'alwaysUnmuted',
      })
      .error(1500);
    await saving;
    expect(component['open']()).toBe(true);
    expect(component['failed']()).toBe(true);
    expect(store.chatState(testChat.id)?.muteOverride).toBe(before);
    fixture.destroy();
    peer.verify();
  });
});
