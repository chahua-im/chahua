import { vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatList } from '../chat-list/chat-list';
import { ChatListPage } from './chat-list.page';

@Component({ selector: 'app-chat-list', template: '' })
class ListStub {
  readonly active = input(true);
}

describe('ChatListPage', () => {
  it('places the mobile list alongside the desktop conversation placeholder', async () => {
    await TestBed.configureTestingModule({ imports: [ChatListPage] })
      .overrideComponent(ChatListPage, { remove: { imports: [ChatList] }, add: { imports: [ListStub] } })
      .compileComponents();
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('app-chat-list')?.classList.contains('ion-hide-md-up')).toBe(true);
    expect(element.querySelector(':scope > ion-content, :scope > ion-header')).toBeNull();
    expect(element.querySelector('ion-content')?.parentElement?.classList.contains('ion-hide-md-down')).toBe(true);
    expect(element.textContent).toContain('从左侧选择一个会话');
  });
});

// Cached Ionic pages are detached instead of destroyed, so leaving must release their query consumers.
describe('ChatListPage query lifecycle', () => {
  it('releases queries from a detached page and reactivates them on return', async () => {
    const release = vi.fn();
    const query = {
      items: signal([]),
      loading: signal(false),
      error: signal(false),
      activate: vi.fn(() => release),
    };
    await TestBed.configureTestingModule({
      imports: [ChatListPage],
      providers: [
        provideRouter([]),
        {
          provide: ChatListStore,
          useValue: {
            chats: () => query,
            friendRequests: () => query,
            threads: () => query,
            archivedUnread: { chats: query, threads: query },
          },
        },
        { provide: ChatStore, useValue: {} },
        { provide: SessionStore, useValue: { user: signal(undefined) } },
        { provide: Preferences, useValue: { showThreadsInMessages: () => true } },
      ],
    })
      .overrideComponent(ChatList, { set: { template: '' } })
      .compileComponents();
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    expect(query.activate).toHaveBeenCalledTimes(5);
    fixture.componentRef.changeDetectorRef.detach();
    fixture.componentInstance.ionViewDidLeave();
    expect(release).toHaveBeenCalledTimes(5);
    fixture.componentRef.changeDetectorRef.reattach();
    fixture.componentInstance.ionViewDidEnter();
    await fixture.whenStable();
    expect(query.activate).toHaveBeenCalledTimes(10);
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(10);
  });
});
