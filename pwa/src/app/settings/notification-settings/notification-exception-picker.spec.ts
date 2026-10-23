import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupKind } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { mockRealtime, testChat, testUser, wireChat } from '../../api/testing';
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
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime() },
        { provide: ChatListStore, useValue: { chats: (archive: boolean) => (archive ? archived : active) } },
      ],
    });
    TestBed.inject(SessionStore).user.set({
      ...testUser,
      muteGroupChatsByDefault: muted,
      muteDirectChatsByDefault: muted,
    });
    const store = TestBed.inject(ChatStore);
    store.acceptChats([{ ...testChat, kind, archived: true }], store.snapshot());
    const fixture = TestBed.createComponent(NotificationExceptionPicker);
    fixture.componentRef.setInput('kind', kind);
    return {
      fixture,
      component: fixture.componentInstance,
      http: TestBed.inject(HttpTestingController),
      store,
      release,
    };
  }

  it.each([
    [GroupKind.group, true, 'alwaysUnmuted'],
    [GroupKind.dm, false, 'alwaysMuted'],
  ] as const)('adds a %s exception opposite to default without unarchiving', async (kind, muted, mode) => {
    const { fixture, component, http, store, release } = setup(kind, muted);
    expect(component['targets']()).toHaveLength(1); // active/archive overlap during synchronization
    const saving = component['select'](testChat.id);
    const req = http.expectOne(`/_api/group/${wireChat.id}/notification-setting`);
    expect(req.request.body).toEqual({ mode });
    req.flush({ chatId: wireChat.id, kind, archived: true, muteOverride: !muted, mutedUntil: null, isMuted: !muted });
    await saving;
    expect(component['open']()).toBe(false);
    expect(store.chatState(testChat.id)?.archived).toBe(true);
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(2);
    http.verify();
  });

  it('retains the picker and restores preferences after a failed add', async () => {
    const { fixture, component, http, store } = setup();
    const before = store.chatState(testChat.id)?.muteOverride;
    const saving = component['select'](testChat.id);
    http
      .expectOne(`/_api/group/${wireChat.id}/notification-setting`)
      .flush('failed', { status: 500, statusText: 'Failed' });
    await saving;
    expect(component['open']()).toBe(true);
    expect(component['failed']()).toBe(true);
    expect(store.chatState(testChat.id)?.muteOverride).toBe(before);
    fixture.destroy();
    http.verify();
  });
});
