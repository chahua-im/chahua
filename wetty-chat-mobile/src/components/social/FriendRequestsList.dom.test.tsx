import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendsApi } from '@/api/friends';
import socialReducer from '@/store/socialSlice';
import { FriendRequestsList } from './FriendRequestsList';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (typeof strings === 'string' ? strings : strings.join('')),
}));
vi.mock('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@ionic/react', () => ({
  IonContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonListHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/chat/profiles/UserProfileModal', () => ({ UserProfileModal: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/api/friends', () => ({
  friendsApi: {
    listIncomingRequests: vi.fn(async () => []),
    listOutgoingRequests: vi.fn(async () => []),
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
  it('hydrates both request directions and shows the empty state', async () => {
    const store = configureStore({ reducer: { social: socialReducer } });

    await act(async () => {
      root.render(
        <Provider store={store}>
          <FriendRequestsList />
        </Provider>,
      );
      await Promise.resolve();
    });

    expect(friendsApi.listIncomingRequests).toHaveBeenCalledOnce();
    expect(friendsApi.listOutgoingRequests).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('No pending friend requests');
  });
});
