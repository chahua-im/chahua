import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(() => null as string | null),
  clear: vi.fn(() => Promise.resolve()),
  commit: vi.fn(() => Promise.resolve()),
  load: vi.fn(() => Promise.resolve('stored-token')),
  refresh: vi.fn(() => Promise.resolve('refreshed-token')),
  initialize: vi.fn(() => Promise.resolve('client-id')),
  issue: vi.fn(() => Promise.resolve('dev-token')),
  getUid: vi.fn(() => 1),
}));

vi.mock('@/utils/jwtToken', () => ({
  captureJwtTokenFromUrl: mocks.capture,
  clearJwtToken: mocks.clear,
  commitJwtToken: mocks.commit,
  loadStoredJwtToken: mocks.load,
}));
vi.mock('@/api/authBootstrap', () => ({
  AuthBootstrapError: class AuthBootstrapError extends Error {
    category: string;
    constructor(category: string) {
      super(category);
      this.category = category;
    }
  },
  issueDevelopmentSession: mocks.issue,
  refreshSessionToken: mocks.refresh,
}));
import { AuthBootstrapError } from '@/api/authBootstrap';
import { bootstrapAuth } from './authBootstrap';
vi.mock('@/utils/current-user', () => ({ getCurrentUserId: mocks.getUid }));
vi.mock('@/utils/clientId', () => ({ initializeClientId: mocks.initialize }));

vi.stubGlobal('__AUTH_REDIRECT_URL__', null);
vi.stubGlobal('window', { location: { href: 'https://example.test/' } });

describe('auth bootstrap coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capture.mockReset();
    mocks.capture.mockReturnValue(null);
    mocks.load.mockReset();
    mocks.load.mockResolvedValue('stored-token');
    mocks.refresh.mockReset();
    mocks.refresh.mockResolvedValue('refreshed-token');
    vi.stubEnv('DEV', false);
  });

  it('gives a query token precedence over stored credentials', async () => {
    mocks.capture.mockReturnValueOnce('query-token');
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'ready' });
    expect(mocks.commit).toHaveBeenNthCalledWith(1, 'query-token');
    expect(mocks.refresh).toHaveBeenCalledWith('query-token');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('uses the development session issuer on Vite development builds', async () => {
    vi.stubEnv('DEV', true);
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'ready' });
    expect(mocks.initialize).toHaveBeenCalled();
    expect(mocks.issue).toHaveBeenCalledWith(1, 'client-id');
    expect(mocks.commit).toHaveBeenCalledWith('dev-token');
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('falls back to a valid stored JWT when development session issuance fails', async () => {
    vi.stubEnv('DEV', true);
    mocks.issue.mockRejectedValueOnce(new AuthBootstrapError('transient'));
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'ready' });
    expect(mocks.load).toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledWith('stored-token');
    expect(mocks.commit).toHaveBeenCalledWith('refreshed-token');
  });

  it('reports development-session when issuance fails and no stored JWT exists', async () => {
    vi.stubEnv('DEV', true);
    mocks.issue.mockRejectedValueOnce(new AuthBootstrapError('transient'));
    mocks.load.mockResolvedValueOnce('');
    await expect(bootstrapAuth()).resolves.toEqual({
      status: 'error',
      category: 'development-session',
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refreshes stored credentials before reporting ready', async () => {
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'ready' });
    expect(mocks.refresh).toHaveBeenCalledWith('stored-token');
    expect(mocks.commit).toHaveBeenCalledWith('refreshed-token');
  });

  it('clears a rejected credential and returns signed-out without redirect', async () => {
    mocks.refresh.mockRejectedValueOnce(new AuthBootstrapError('unauthorized'));
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'signed-out' });
    expect(mocks.clear).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight attempt and allows a later retry', async () => {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((nextResolve) => {
      resolve = nextResolve;
    });
    mocks.load.mockImplementationOnce(() => promise);
    const first = bootstrapAuth();
    const second = bootstrapAuth();
    expect(first).toBe(second);
    resolve('stored-token');
    await first;
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'ready' });
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it('returns redirecting for retries while navigation is pending', async () => {
    const replace = vi.fn();
    window.location.replace = replace;
    vi.stubGlobal('__AUTH_REDIRECT_URL__', '/login');
    mocks.refresh.mockRejectedValue(new AuthBootstrapError('unauthorized'));

    await expect(bootstrapAuth()).resolves.toEqual({ status: 'redirecting' });
    await expect(bootstrapAuth()).resolves.toEqual({ status: 'redirecting' });
    expect(replace).toHaveBeenCalledTimes(1);
    vi.stubGlobal('__AUTH_REDIRECT_URL__', null);
  });
});
