import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLandingInviteFlow } from './useLandingInviteFlow';

const { syncPendingInviteFromLanding, parsePendingInviteFromLanding, kvSet } = vi.hoisted(() => ({
  syncPendingInviteFromLanding: vi.fn(() => 'invite-code'),
  parsePendingInviteFromLanding: vi.fn(() => 'parsed-invite'),
  kvSet: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('@/utils/db', () => ({ kvSet }));
vi.mock('@/utils/pendingInvite', () => ({
  parsePendingInviteFromLanding,
  syncPendingInviteFromLanding,
}));

function TestComponent({
  isPwa,
  onRender,
  search = '?token=legacy&invite=invite-code',
}: {
  isPwa: boolean;
  onRender: (value: string | null) => void;
  search?: string;
}) {
  const { landingInviteCode } = useLandingInviteFlow({ search, isPwa, appEntryUrl: '/app' });
  onRender(landingInviteCode);
  return null;
}

describe('landing invite flow', () => {
  let root: Root;
  let container: HTMLDivElement;
  const realLocation = window.location;

  const stubLocation = (search: string) => {
    const reload = vi.fn();
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, href: `https://app.test/landing${search}`, search, reload, replace },
    });
    return { reload, replace };
  };

  beforeEach(() => {
    vi.resetModules();
    kvSet.mockClear();
    syncPendingInviteFromLanding.mockClear();
    parsePendingInviteFromLanding.mockClear();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('captures the invite without adopting or persisting the query token', async () => {
    stubLocation('?invite=invite-code');
    let invite: string | null = null;
    await act(async () => {
      root.render(
        React.createElement(TestComponent, {
          isPwa: false,
          search: '?invite=invite-code',
          onRender: (value: string | null) => (invite = value),
        }),
      );
      await Promise.resolve();
    });

    expect(invite).toBe('parsed-invite');
    expect(kvSet).not.toHaveBeenCalledWith('jwt_token', expect.anything());
    expect(parsePendingInviteFromLanding).toHaveBeenCalledWith('?invite=invite-code');
  });

  it('ignores a stale router token that bootstrap already stripped from the URL', async () => {
    const { reload } = stubLocation('?invite=invite-code');

    await act(async () => {
      root.render(React.createElement(TestComponent, { isPwa: false, onRender: () => undefined }));
      await Promise.resolve();
    });

    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads a mounted browser tab so bootstrap can adopt the query token', async () => {
    const { reload } = stubLocation('?token=legacy&invite=invite-code');

    await act(async () => {
      root.render(React.createElement(TestComponent, { isPwa: false, onRender: () => undefined }));
      await Promise.resolve();
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(kvSet).not.toHaveBeenCalledWith('jwt_token', expect.anything());
  });

  it('preserves the query token when redirecting an installed PWA', async () => {
    const { replace } = stubLocation('?token=legacy&invite=invite-code');

    await act(async () => {
      root.render(React.createElement(TestComponent, { isPwa: true, onRender: () => undefined }));
      await Promise.resolve();
    });

    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/app?token=legacy'));
    expect(kvSet).not.toHaveBeenCalledWith('jwt_token', expect.anything());
  });

  it('redirects installed PWAs to the plain entry URL without a token', async () => {
    const { replace } = stubLocation('?invite=code');

    await act(async () => {
      root.render(
        React.createElement(TestComponent, { isPwa: true, search: '?invite=code', onRender: () => undefined }),
      );
      await Promise.resolve();
    });

    expect(replace).toHaveBeenCalledWith(expect.stringContaining('/app'));
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining('token='));
  });
});
