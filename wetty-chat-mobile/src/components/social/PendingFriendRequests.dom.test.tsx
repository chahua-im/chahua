import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FriendRequestHistoryEntry } from '@/api/friends';
import socialReducer from '@/store/socialSlice';
import { FriendRequestRow, PendingFriendRequests } from './PendingFriendRequests';

const fixtures: FriendRequestHistoryEntry[] = [
  {
    id: 'incoming-pending',
    from: { uid: 2, username: 'Bob', gender: 0 },
    to: { uid: 1, username: 'Alice', gender: 0 },
    status: 'pending' as const,
    createdAt: '2026-08-18T00:00:00Z',
    decidedAt: null,
    message: 'hi there',
    direction: 'incoming' as const,
  },
];

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    typeof strings === 'string'
      ? strings
      : strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));
vi.mock('@ionic/react', () => ({
  IonButton: ({ children, onClick, 'aria-label': label }: React.ComponentProps<'button'>) => (
    <button onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
  IonIcon: () => null,
  IonItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <div onClick={onClick}>{children}</div>
  ),
  IonLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonNote: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/chat/profiles/UserProfileModal', () => ({ UserProfileModal: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/social/useFriendRequestActions', () => ({
  useFriendRequestActions: () => ({ acceptRequest: vi.fn(), rejectRequest: vi.fn(), archiveRequest: vi.fn() }),
}));
let container: HTMLDivElement;
let root: Root;

function renderRequests(requests: FriendRequestHistoryEntry[]) {
  const store = configureStore({
    reducer: { social: socialReducer },
    preloadedState: {
      social: {
        friends: [],
        friendsLoaded: false,
        pendingRequests: requests,
        archivedRequests: [],
        blocks: [],
        blocksLoaded: false,
      },
    },
  });

  act(() => {
    root.render(
      <Provider store={store}>
        <PendingFriendRequests />
      </Provider>,
    );
  });
}

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
  vi.clearAllMocks();
});

describe('PendingFriendRequests', () => {
  it('renders actions for unarchived requests', () => {
    renderRequests(fixtures);

    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('hi there');
    expect(Array.from(container.querySelectorAll('button'), (button) => button.getAttribute('aria-label'))).toEqual([
      'Accept',
      'Reject',
      'Archive',
    ]);
  });

  it('renders nothing when there are no pending requests', () => {
    renderRequests([]);

    expect(container.textContent).toBe('');
  });

  it('renders archived unresolved requests as pending without actions', () => {
    act(() => {
      root.render(
        <FriendRequestRow request={{ ...fixtures[0], status: 'archived' }} onOpenProfile={() => undefined} />,
      );
    });

    expect(container.textContent).toContain('Pending approval');
    expect(container.querySelector('button')).toBeNull();
  });
});
