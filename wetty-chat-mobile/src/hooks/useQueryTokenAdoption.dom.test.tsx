import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshSessionToken, commitJwtToken, getStoredJwtToken } = vi.hoisted(() => ({
  refreshSessionToken: vi.fn<(token: string) => Promise<string>>(),
  commitJwtToken: vi.fn<(token: string) => Promise<void>>(),
  getStoredJwtToken: vi.fn<() => string>(),
}));

vi.mock('@/api/authBootstrap', () => ({ refreshSessionToken }));
vi.mock('@/utils/jwtToken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/jwtToken')>()),
  commitJwtToken,
  getStoredJwtToken,
}));

import { useQueryTokenAdoption } from './useQueryTokenAdoption';

function TokenAdopterProbe() {
  useQueryTokenAdoption();
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

function jwt(uid: number, nonce = ''): string {
  return `header.${btoa(JSON.stringify({ uid, cid: 'client', nonce }))}.signature`;
}

describe('query token adoption', () => {
  let root: Root;
  let container: HTMLDivElement;
  const realLocation = window.location;

  function stubLocation(pathname: string, search: string) {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, href: `https://app.test${pathname}${search}`, pathname, search, reload },
    });
    return reload;
  }

  async function render(path: string) {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <TokenAdopterProbe />
        </MemoryRouter>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    refreshSessionToken.mockReset();
    commitJwtToken.mockReset();
    getStoredJwtToken.mockReset();
    commitJwtToken.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.restoreAllMocks();
  });

  it('adopts a same-user token and preserves non-token query parameters', async () => {
    const currentToken = jwt(7, 'stored');
    const incomingToken = jwt(7, 'incoming');
    const refreshedToken = jwt(7, 'refreshed');
    const reload = stubLocation('/profile', `?uid=5&token=${incomingToken}`);
    getStoredJwtToken.mockReturnValue(currentToken);
    refreshSessionToken.mockResolvedValue(refreshedToken);

    await render(`/profile?uid=5&token=${incomingToken}`);

    expect(refreshSessionToken).toHaveBeenCalledWith(incomingToken);
    expect(commitJwtToken).toHaveBeenCalledWith(refreshedToken);
    expect(reload).not.toHaveBeenCalled();
    expect(container.textContent).toBe('/profile?uid=5');
  });

  it('reloads after adopting a different-user token', async () => {
    const incomingToken = jwt(9, 'incoming');
    const reload = stubLocation('/chats', `?token=${incomingToken}`);
    getStoredJwtToken.mockReturnValue(jwt(7, 'stored'));
    refreshSessionToken.mockResolvedValue(jwt(9, 'refreshed'));

    await render(`/chats?token=${incomingToken}`);

    expect(commitJwtToken).toHaveBeenCalledWith(jwt(9, 'refreshed'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the current session when token validation fails', async () => {
    const incomingToken = jwt(10, 'incoming');
    const reload = stubLocation('/chats', `?token=${incomingToken}`);
    getStoredJwtToken.mockReturnValue(jwt(7, 'stored'));
    refreshSessionToken.mockRejectedValue(new Error('expired'));

    await render(`/chats?token=${incomingToken}`);

    expect(commitJwtToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves landing token handoff to the landing route', async () => {
    const incomingToken = jwt(7, 'incoming');
    stubLocation('/landing', `?token=${incomingToken}`);

    await render(`/landing?token=${incomingToken}`);

    expect(refreshSessionToken).not.toHaveBeenCalled();
    expect(commitJwtToken).not.toHaveBeenCalled();
  });
});
