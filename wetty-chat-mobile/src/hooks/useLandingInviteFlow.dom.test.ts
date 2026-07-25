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

function TestComponent({ isPwa, onRender }: { isPwa: boolean; onRender: (value: string | null) => void }) {
  const { landingInviteCode } = useLandingInviteFlow({
    search: '?token=legacy&invite=invite-code',
    isPwa,
    appEntryUrl: '/app',
  });
  onRender(landingInviteCode);
  return null;
}

describe('landing invite flow', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.resetModules();
    kvSet.mockClear();
    syncPendingInviteFromLanding.mockClear();
    parsePendingInviteFromLanding.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('captures the invite without adopting or persisting the query token', async () => {
    let invite: string | null = null;
    await act(async () => {
      root.render(
        React.createElement(TestComponent, { isPwa: false, onRender: (value: string | null) => (invite = value) }),
      );
      await Promise.resolve();
    });

    expect(invite).toBe('parsed-invite');
    expect(kvSet).not.toHaveBeenCalledWith('jwt_token', expect.anything());
    expect(parsePendingInviteFromLanding).toHaveBeenCalledWith('?token=legacy&invite=invite-code');
  });

  it('redirects installed PWAs without re-adopting the query token', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);

    await act(async () => {
      root.render(React.createElement(TestComponent, { isPwa: true, onRender: () => undefined }));
      await Promise.resolve();
    });

    expect(replace).toHaveBeenCalledWith('/app');
    replace.mockRestore();
  });

  it('redirects installed PWAs while preserving invite capture', async () => {
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
    await act(async () => {
      root.render(React.createElement(TestComponent, { isPwa: true, onRender: () => undefined }));
      await Promise.resolve();
    });

    expect(replace).toHaveBeenCalledWith('/app');
    expect(kvSet).not.toHaveBeenCalledWith('jwt_token', expect.anything());
    replace.mockRestore();
  });
});
