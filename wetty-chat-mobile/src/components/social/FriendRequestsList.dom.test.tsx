import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendsApi } from '@/api/friends';
import socialReducer from '@/store/socialSlice';
import { FriendRequestsList } from './FriendRequestsList';

const fixtures = vi.hoisted(() => [
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
  {
    id: 'outgoing-pending',
    from: { uid: 1, username: 'Alice', gender: 0 },
    to: { uid: 3, username: 'Cara', gender: 0 },
    status: 'pending' as const,
    createdAt: '2026-08-17T00:00:00Z',
    decidedAt: null,
    direction: 'outgoing' as const,
  },
  {
    id: 'incoming-accepted',
    from: { uid: 4, username: 'Dan', gender: 0 },
    to: { uid: 1, username: 'Alice', gender: 0 },
    status: 'accepted' as const,
    createdAt: '2026-08-16T00:00:00Z',
    decidedAt: '2026-08-16T01:00:00Z',
    direction: 'incoming' as const,
  },
  {
    id: 'outgoing-rejected',
    from: { uid: 1, username: 'Alice', gender: 0 },
    to: { uid: 5, username: 'Eve', gender: 0 },
    status: 'rejected' as const,
    createdAt: '2026-08-15T00:00:00Z',
    decidedAt: '2026-08-15T01:00:00Z',
    direction: 'outgoing' as const,
  },
]);

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    typeof strings === 'string'
      ? strings
      : strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));
vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@ionic/react', () => ({
  IonButton: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  IonContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <div onClick={onClick}>{children}</div>
  ),
  IonLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonNote: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
vi.mock('@/components/chat/profiles/UserProfileModal', () => ({ UserProfileModal: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/social/useFriendRequestActions', () => ({
  useFriendRequestActions: () => ({ acceptRequest: vi.fn(), rejectRequest: vi.fn() }),
}));
vi.mock('@/api/friends', () => ({
  friendsApi: {
    listRequestHistory: vi.fn(async () => fixtures),
  },
}));

let container: HTMLDivElement;
let root: Root;

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

describe('FriendRequestsList', () => {
  it('renders complete server-ordered history with pending actions and resolved statuses', async () => {
    const store = configureStore({ reducer: { social: socialReducer } });

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FriendRequestsList />
        </Provider>,
      );
      await Promise.resolve();
    });

    expect(friendsApi.listRequestHistory).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('hi there');
    expect(container.textContent).toContain('Cara');
    expect(container.textContent).toContain('Dan');
    expect(container.textContent).toContain('Eve');
    expect(container.textContent).toContain('Pending approval');
    expect(container.textContent).toContain('Accepted');
    expect(container.textContent).toContain('Rejected');
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent?.indexOf('Bob')).toBeLessThan(container.textContent?.indexOf('Cara') ?? Infinity);
    expect(container.textContent?.indexOf('Cara')).toBeLessThan(container.textContent?.indexOf('Dan') ?? Infinity);
    expect(container.textContent?.indexOf('Dan')).toBeLessThan(container.textContent?.indexOf('Eve') ?? Infinity);
  });

  it('shows the empty history state when no requests exist', async () => {
    vi.mocked(friendsApi.listRequestHistory).mockResolvedValueOnce([]);
    const store = configureStore({ reducer: { social: socialReducer } });

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FriendRequestsList />
        </Provider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('No friend requests');
  });
});
