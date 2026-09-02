import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usersApi } from '@/api/users';
import { requestProfileDeepLink } from '@/utils/profileDeepLink';
import { ProfileDeepLinkHost } from './ProfileDeepLinkHost';

const fixtures = vi.hoisted(() => ({
  searchMembers: vi.fn(),
}));

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
    typeof strings === 'string'
      ? strings
      : strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ''}`, ''),
}));
vi.mock('@ionic/react', () => ({
  IonToast: ({ isOpen, message }: { isOpen: boolean; message: string }) =>
    isOpen ? <div role="status">{message}</div> : null,
}));
vi.mock('@/api/users', () => ({
  usersApi: {
    searchMembers: fixtures.searchMembers,
  },
}));
vi.mock('@/components/chat/profiles/UserProfileModal', () => ({
  UserProfileModal: ({ sender }: { sender: { uid: number } | null }) => (
    <div data-testid="profile-user">{sender?.uid}</div>
  ),
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

describe('ProfileDeepLinkHost', () => {
  it('opens the profile modal for an exact uid match', async () => {
    vi.mocked(usersApi.searchMembers).mockResolvedValueOnce({
      members: [{ uid: 42, username: 'Ada', avatarUrl: null, gender: 0, userGroup: null }],
      excluded: [],
    });
    requestProfileDeepLink(42);

    await act(async () => {
      root.render(<ProfileDeepLinkHost />);
      await Promise.resolve();
    });

    expect(usersApi.searchMembers).toHaveBeenCalledWith({ q: '42', limit: 1 });
    expect(container.querySelector('[data-testid="profile-user"]')?.textContent).toBe('42');
    expect(container.textContent).not.toContain('User not found');
  });

  it('shows a not-found toast when search has no exact uid match', async () => {
    vi.mocked(usersApi.searchMembers).mockResolvedValueOnce({
      members: [{ uid: 24, username: 'Other', avatarUrl: null, gender: 0, userGroup: null }],
      excluded: [],
    });
    requestProfileDeepLink(42);

    await act(async () => {
      root.render(<ProfileDeepLinkHost />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="profile-user"]')?.textContent).toBe('');
    expect(container.textContent).toContain('User not found');
  });
});
