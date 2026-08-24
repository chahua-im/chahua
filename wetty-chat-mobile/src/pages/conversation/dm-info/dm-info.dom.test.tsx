import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocksApi } from '@/api/blocks';
import { friendsApi } from '@/api/friends';
import chatsReducer, { setChatMeta } from '@/store/chatsSlice';
import socialReducer, { blockAdded, friendAdded } from '@/store/socialSlice';
import DmInfoCore from './dm-info';

const presenters = vi.hoisted(() => ({
  alert: vi.fn(),
  toast: vi.fn(),
}));

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
  IonButtons: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  IonIcon: () => <span />,
  IonItem: ({
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
  IonLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  IonList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  IonSpinner: () => <span />,
  IonTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  IonToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useIonAlert: () => [presenters.alert],
  useIonToast: () => [presenters.toast],
}));
vi.mock('@/hooks/useFeatureGate', () => ({ useFeatureGate: () => true }));
vi.mock('@/components/FeatureGate', () => ({
  FeatureGate: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/pages/conversation/group-info/useGroupInfoMetadata', () => ({
  useGroupInfoMetadata: () => ({ archived: false, loading: false, mutedUntil: null }),
}));
vi.mock('@/components/chat/settings/ChatMuteSettingItem', () => ({
  ChatMuteSettingItem: () => <span>Mute</span>,
}));
vi.mock('@/components/chat/search/ChatMessageSearchPanel', () => ({
  ChatMessageSearchPanel: () => <span>Message Search</span>,
}));
vi.mock('@/components/chat/attachments/ChatAttachmentSection', () => ({
  ChatAttachmentSection: () => <span>Attachments</span>,
}));
vi.mock('@/components/chat/profiles/UserProfileModal', () => ({ UserProfileModal: () => null }));
vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => <span /> }));
vi.mock('@/components/BackButton', () => ({ BackButton: () => <button type="button">Back</button> }));
vi.mock('@/components/chat/settings/GroupSettingsActionButton', () => ({
  GroupSettingsActionButton: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock('@/api/friends', () => ({
  friendsApi: {
    removeFriend: vi.fn().mockResolvedValue(undefined),
    listFriends: vi
      .fn()
      .mockResolvedValue([{ user: { uid: 7, username: 'Bob', avatarUrl: null, gender: 0 }, since: '' }]),
  },
}));
vi.mock('@/api/blocks', () => ({
  blocksApi: {
    unblockUser: vi.fn().mockResolvedValue(undefined),
    blockUser: vi.fn().mockResolvedValue(undefined),
    listBlocks: vi.fn().mockResolvedValue([]),
  },
}));

const peerRecord = () => ({ uid: 7, username: 'Bob', avatarUrl: null, gender: 0 });

let container: HTMLDivElement;
let root: Root;

function createDmStore(peer = true) {
  const store = configureStore({ reducer: { social: socialReducer, chats: chatsReducer } });
  store.dispatch(friendAdded({ user: peerRecord(), since: '' }));
  if (peer) {
    store.dispatch(setChatMeta({ chatId: 'dm-1', meta: { kind: 'dm', peer: peerRecord() } }));
  } else {
    store.dispatch(setChatMeta({ chatId: 'dm-1', meta: { kind: 'dm' } }));
  }
  return store;
}

async function renderPanel(peer = true, blocked = false) {
  if (blocked) {
    vi.mocked(blocksApi.listBlocks).mockResolvedValueOnce([{ user: peerRecord(), since: '' }]);
  }
  const store = createDmStore(peer);
  if (blocked) {
    store.dispatch(blockAdded({ user: peerRecord(), since: '' }));
  }
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MemoryRouter>
          <DmInfoCore chatId="dm-1" />
        </MemoryRouter>
      </Provider>,
    );
    await Promise.resolve();
  });
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

describe('DmInfoCore', () => {
  it('renders peer actions and unfriend confirmation invokes the peer API', async () => {
    await renderPanel();

    expect(container.textContent).toContain('Bob');
    expect(container.textContent).toContain('Block');
    expect(container.textContent).toContain('Unfriend');
    expect(container.textContent?.match(/Search/g)).toHaveLength(1);

    const unfriend = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Unfriend');
    await act(async () => unfriend?.click());
    const options = presenters.alert.mock.calls[0][0];
    const confirm = options.buttons.find((button: { text: string }) => button.text === 'Remove');
    expect(confirm.role).toBe('destructive');
    await act(async () => {
      confirm.handler();
      await Promise.resolve();
    });
    expect(friendsApi.removeFriend).toHaveBeenCalledWith(7);
  });

  it('unblocks a blocked peer through the confirmation action', async () => {
    await renderPanel(true, true);

    const unblock = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Unblock');
    await act(async () => unblock?.click());
    const options = presenters.alert.mock.calls[0][0];
    const confirm = options.buttons.find((button: { text: string }) => button.text === 'Unblock');
    await act(async () => {
      confirm.handler();
      await Promise.resolve();
    });
    expect(blocksApi.unblockUser).toHaveBeenCalledWith(7);
  });

  it('withholds peer danger actions when metadata has no peer', async () => {
    await renderPanel(false);

    expect(container.textContent).not.toContain('Block');
    expect(container.textContent).not.toContain('Unfriend');
  });
});
