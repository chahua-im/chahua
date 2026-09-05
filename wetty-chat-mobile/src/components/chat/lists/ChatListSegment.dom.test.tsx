import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { FriendRequestHistoryEntry } from '@/api/friends';
import socialReducer from '@/store/socialSlice';
import { ChatListSegment } from './ChatListSegment';

vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@ionic/react', () => ({
  IonBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  IonLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  IonSegment: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  IonSegmentButton: ({ children, value }: { children: ReactNode; value: string }) => (
    <button data-tab={value}>{children}</button>
  ),
}));

function renderSegment({
  archivedMode,
  pendingIncomingCount,
}: {
  archivedMode: boolean;
  pendingIncomingCount: number;
}) {
  const pendingRequests: FriendRequestHistoryEntry[] = Array.from({ length: pendingIncomingCount }, (_, index) => ({
    id: String(index),
    from: { uid: index + 2, username: `User ${index + 2}`, gender: 0 },
    to: { uid: 1, username: 'Alice', gender: 0 },
    status: 'pending',
    createdAt: '2026-08-18T00:00:00Z',
    decidedAt: null,
    direction: 'incoming',
  }));
  const store = configureStore({
    reducer: { social: socialReducer },
    preloadedState: {
      social: {
        friends: [],
        friendsLoaded: false,
        pendingRequests,
        archivedRequests: [],
        blocks: [],
        blocksLoaded: false,
      },
    },
  });

  return (
    <Provider store={store}>
      <ChatListSegment
        value="friends"
        onChange={() => undefined}
        messagesUnreadCount={0}
        groupsUnreadCount={0}
        friendsUnreadCount={2}
        threadsUnreadCount={0}
        archivedMode={archivedMode}
        friendsEnabled
      />
    </Provider>
  );
}

describe('ChatListSegment archived Friends tab', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows Friends with its unread badge in archived mode', () => {
    act(() => {
      root.render(renderSegment({ archivedMode: true, pendingIncomingCount: 9 }));
    });

    expect(container.querySelector('[data-tab="friends"]')?.textContent).toBe('Friends2');
    expect(container.querySelector('[data-tab="friends"]')?.textContent).not.toContain('9');
  });

  it('prioritizes pending friend requests in the active list', () => {
    act(() => {
      root.render(renderSegment({ archivedMode: false, pendingIncomingCount: 9 }));
    });

    expect(container.querySelector('[data-tab="friends"]')?.textContent).toBe('Friends9');
    expect(container.querySelector('[data-tab="friends"]')?.textContent).not.toContain('Friends2');
  });
});
