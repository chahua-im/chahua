import { getCurrentUserId } from '@/utils/current-user';
import { initializeClientId } from '@/utils/clientId';
import { issueDevelopmentSession, refreshSessionToken, AuthBootstrapError } from '@/api/authBootstrap';
import { captureJwtTokenFromUrl, clearJwtToken, commitJwtToken, loadStoredJwtToken } from '@/utils/jwtToken';

export type AuthBootstrapResult =
  | { status: 'ready' }
  | { status: 'redirecting' }
  | { status: 'signed-out' }
  | { status: 'error'; category: 'transient' | 'invalid-response' | 'persistence' | 'development-session' };

let inFlight: Promise<AuthBootstrapResult> | null = null;
let redirectStarted = false;

function errorResult(error: unknown, development = false): AuthBootstrapResult {
  if (error instanceof AuthBootstrapError) {
    return {
      status: 'error',
      category: development ? 'development-session' : error.category === 'unauthorized' ? 'transient' : error.category,
    };
  }
  return { status: 'error', category: 'persistence' };
}

async function clearAfterUnauthorized(): Promise<AuthBootstrapResult> {
  const redirectUrl = typeof __AUTH_REDIRECT_URL__ === 'string' ? __AUTH_REDIRECT_URL__ : null;
  try {
    await clearJwtToken();
  } catch (error) {
    return errorResult(error);
  }
  if (redirectUrl) {
    if (!redirectStarted) {
      redirectStarted = true;
      window.location.replace(redirectUrl);
    }
    return { status: 'redirecting' };
  }
  return { status: 'signed-out' };
}

async function runBootstrap(): Promise<AuthBootstrapResult> {
  const queryToken = captureJwtTokenFromUrl(new URL(window.location.href));
  if (queryToken) {
    try {
      await commitJwtToken(queryToken);
      const refreshedToken = await refreshSessionToken(queryToken);
      await commitJwtToken(refreshedToken);
      return { status: 'ready' };
    } catch (error) {
      if (error instanceof AuthBootstrapError && error.category === 'unauthorized') {
        return clearAfterUnauthorized();
      }
      return errorResult(error);
    }
  }

  if (import.meta.env.DEV) {
    try {
      const clientId = await initializeClientId();
      const token = await issueDevelopmentSession(getCurrentUserId(), clientId);
      await commitJwtToken(token);
      return { status: 'ready' };
    } catch (error) {
      return errorResult(error, true);
    }
  }

  try {
    const token = await loadStoredJwtToken();
    if (!token) return clearAfterUnauthorized();
    const refreshedToken = await refreshSessionToken(token);
    await commitJwtToken(refreshedToken);
    return { status: 'ready' };
  } catch (error) {
    if (error instanceof AuthBootstrapError && error.category === 'unauthorized') {
      return clearAfterUnauthorized();
    }
    return errorResult(error);
  }
}

export function bootstrapAuth(): Promise<AuthBootstrapResult> {
  if (redirectStarted) return Promise.resolve({ status: 'redirecting' });
  if (!inFlight) {
    inFlight = runBootstrap().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
