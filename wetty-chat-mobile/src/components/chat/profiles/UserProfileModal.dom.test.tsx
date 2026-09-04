import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { Router } from 'react-router-dom';
import { createMemoryHistory } from 'history';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { friendsApi } from '@/api/friends';
import chatsReducer from '@/store/chatsSlice';
import { UserProfileModal } from './UserProfileModal';

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    typeof strings === 'string'
      ? strings
      : strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));
vi.mock('@ionic/react', () => ({
  IonButton: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  IonChip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  IonContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonIcon: () => <span />,
  IonLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  IonModal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useIonAlert: () => [vi.fn()],
  useIonToast: () => [vi.fn()],
}));
vi.mock('@/hooks/platformHooks', () => ({ useIsDarkMode: () => false, useIsDesktop: () => false }));
vi.mock('@/hooks/useFeatureGate', () => ({ useFeatureGate: () => true }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => <span /> }));
vi.mock('@/components/social/AddFriendSheet', () => ({ AddFriendSheet: () => null }));
vi.mock('@/components/chat/settings/GroupSettingsActionButton', () => ({
  GroupSettingsActionButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@/api/friends', () => ({
  friendsApi: { getRelationship: vi.fn() },
}));

const profileUser = { uid: 7, name: 'Bob', avatarUrl: null, gender: 0, userGroup: null };

let container: HTMLDivElement;
let root: Root;

async function renderProfile() {
  const history = createMemoryHistory({ initialEntries: ['/chats'] });
  const store = configureStore({
    reducer: {
      chats: chatsReducer,
      user: () => ({ uid: 1 }),
    },
  });

  await act(async () => {
    root.render(
      <Provider store={store}>
        <Router history={history}>
          <UserProfileModal sender={profileUser} onDismiss={vi.fn()} />
        </Router>
      </Provider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  return history;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('UserProfileModal relationship actions', () => {
  it('opens the canonical DM returned by the relationship API', async () => {
    vi.mocked(friendsApi.getRelationship).mockResolvedValue({
      peerUid: 7,
      isFriend: true,
      dmChatId: '99',
      blocking: false,
      blockedBy: false,
      canDm: true,
      hasPendingOutgoingRequest: false,
    });

    const history = await renderProfile();

    const messageButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Message',
    );
    expect(messageButton).toBeDefined();
    act(() => messageButton?.click());
    expect(history.location.pathname).toBe('/chats/chat/99');
  });

  it('does not offer profile actions when either user has blocked the other', async () => {
    vi.mocked(friendsApi.getRelationship).mockResolvedValue({
      peerUid: 7,
      isFriend: false,
      dmChatId: null,
      blocking: false,
      blockedBy: true,
      canDm: false,
      hasPendingOutgoingRequest: false,
    });

    await renderProfile();

    expect(container.textContent).not.toContain('Add Friend');
    expect(container.textContent).not.toContain('Message');
  });

  it('disables Add Friend for an outgoing pending request', async () => {
    vi.mocked(friendsApi.getRelationship).mockResolvedValue({
      peerUid: 7,
      isFriend: false,
      dmChatId: null,
      blocking: false,
      blockedBy: false,
      canDm: false,
      hasPendingOutgoingRequest: true,
    });

    await renderProfile();

    const addFriendButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add Friend',
    );
    expect(addFriendButton).toBeDefined();
    expect(addFriendButton?.disabled).toBe(true);
  });
});
