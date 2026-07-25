import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvGet, kvSet } = vi.hoisted(() => ({
  kvGet: vi.fn(),
  kvSet: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/utils/db', () => ({ kvGet, kvSet }));
import { getOrCreateClientId, initializeClientId, syncClientIdFromJwt } from './clientId';

function tokenWithCid(cid: string): string {
  const payload = btoa(JSON.stringify({ cid })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

describe('client ID persistence', () => {
  beforeEach(() => {
    kvGet.mockReset();
    kvSet.mockClear();
  });

  it('awaits IndexedDB persistence when syncing from a JWT', async () => {
    let resolveWrite!: () => void;
    kvSet.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveWrite = resolve)));
    const pending = syncClientIdFromJwt(tokenWithCid('client-from-token'));
    expect(kvSet).toHaveBeenCalledWith('client_id', 'client-from-token');
    let resolved = false;
    void pending.then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
    resolveWrite();
    await pending;
    expect(getOrCreateClientId()).toBe('client-from-token');
  });

  it('initializes from stored client ID', async () => {
    kvGet.mockResolvedValueOnce('stored-client');
    await expect(initializeClientId()).resolves.toBe('stored-client');
    expect(kvSet).not.toHaveBeenCalled();
  });
});
