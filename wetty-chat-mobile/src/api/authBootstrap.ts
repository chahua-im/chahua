import axios from 'axios';

// Bootstrap blocks first render, so an unbounded request would hold the splash
// forever. Failing over to the Retry screen beats an indefinite spinner.
const BOOTSTRAP_TIMEOUT_MS = 10_000;

const authBootstrapClient = axios.create({ baseURL: __API_BASE__, timeout: BOOTSTRAP_TIMEOUT_MS });

type AuthBootstrapErrorCategory = 'unauthorized' | 'transient' | 'invalid-response';

export class AuthBootstrapError extends Error {
  readonly category: AuthBootstrapErrorCategory;
  readonly cause: unknown;

  constructor(category: AuthBootstrapErrorCategory, cause?: unknown) {
    super(`Authentication bootstrap failed: ${category}`);
    this.name = 'AuthBootstrapError';
    this.category = category;
    this.cause = cause;
  }
}

function mapBootstrapError(error: unknown): AuthBootstrapError {
  if (error instanceof AuthBootstrapError) return error;
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 401) {
      return new AuthBootstrapError('unauthorized', error);
    }
    if (!error.response || error.response.status >= 500 || error.code === 'ECONNABORTED') {
      return new AuthBootstrapError('transient', error);
    }
  }
  return new AuthBootstrapError('invalid-response', error);
}

function readToken(response: { data?: unknown }): string {
  const token = (response.data as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new AuthBootstrapError('invalid-response', response.data);
  }
  return token;
}

export async function refreshSessionToken(token: string): Promise<string> {
  try {
    const response = await authBootstrapClient.post('/auth/refresh', undefined, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-App-Version': __APP_VERSION__,
      },
    });
    return readToken(response);
  } catch (error) {
    throw mapBootstrapError(error);
  }
}

export async function issueDevelopmentSession(uid: number, clientId: string): Promise<string> {
  try {
    const response = await authBootstrapClient.post(
      '/auth/dev-session',
      { uid },
      {
        headers: {
          'X-Client-Id': clientId,
          'X-App-Version': __APP_VERSION__,
          'Content-Type': 'application/json',
        },
      },
    );
    return readToken(response);
  } catch (error) {
    throw mapBootstrapError(error);
  }
}
