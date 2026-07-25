import { describe, expect, it, vi } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({
  default: {
    create: () => ({ post }),
    isAxiosError: (value: unknown) => Boolean((value as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

vi.stubGlobal('__APP_VERSION__', 'test-version');
import { AuthBootstrapError, issueDevelopmentSession, refreshSessionToken } from './authBootstrap';

describe('isolated bootstrap auth HTTP', () => {
  it('refreshes with exactly the bearer and app-version headers', async () => {
    post.mockResolvedValueOnce({ data: { token: 'refreshed' } });
    await expect(refreshSessionToken('legacy-token')).resolves.toBe('refreshed');
    expect(post).toHaveBeenCalledWith('/auth/refresh', undefined, {
      headers: {
        Authorization: 'Bearer legacy-token',
        'X-App-Version': __APP_VERSION__,
      },
    });
  });

  it('issues development sessions without bearer or UID headers', async () => {
    post.mockResolvedValueOnce({ data: { token: 'dev-token' } });
    await expect(issueDevelopmentSession(7, 'client-7')).resolves.toBe('dev-token');
    expect(post).toHaveBeenCalledWith(
      '/auth/dev-session',
      { uid: 7 },
      {
        headers: {
          'X-Client-Id': 'client-7',
          'X-App-Version': __APP_VERSION__,
          'Content-Type': 'application/json',
        },
      },
    );
  });

  it('maps unauthorized, transient, and malformed responses safely', async () => {
    post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 401 } });
    await expect(refreshSessionToken('token')).rejects.toMatchObject({
      category: 'unauthorized',
    });

    post.mockRejectedValueOnce({ isAxiosError: true, code: 'ERR_NETWORK' });
    await expect(refreshSessionToken('token')).rejects.toMatchObject({
      category: 'transient',
    });

    post.mockResolvedValueOnce({ data: {} });
    await expect(refreshSessionToken('token')).rejects.toMatchObject({
      category: 'invalid-response',
    });
    const error = await refreshSessionToken('token').catch((value) => value as AuthBootstrapError);
    expect(error).toBeInstanceOf(AuthBootstrapError);
  });
});
