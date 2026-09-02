import { useEffect } from 'react';
import { useHistory, useLocation, useRouteMatch } from 'react-router-dom';
import { refreshSessionToken } from '@/api/authBootstrap';
import { commitJwtToken, getJwtTokenFromQuery, getJwtUid, getStoredJwtToken } from '@/utils/jwtToken';

let adoptedToken: string | null = null;

/**
 * Adopts a token received through an in-app URL navigation.
 *
 * Cold navigations are handled by auth bootstrap before React mounts. This hook
 * covers URLs that reach an already mounted app frame.
 */
export function useQueryTokenAdoption(): void {
  const history = useHistory();
  const location = useLocation();
  const isLandingRoute = useRouteMatch('/landing');
  const isLandingRouteExact = isLandingRoute?.isExact ?? false;

  useEffect(() => {
    if (isLandingRouteExact) return;

    const rawToken = getJwtTokenFromQuery(window.location.search);
    if (!rawToken) return;

    const params = new URLSearchParams(window.location.search);
    params.delete('token');
    const search = params.toString();
    history.replace({
      pathname: location.pathname,
      search: search ? `?${search}` : '',
      hash: location.hash,
      state: location.state,
    });

    if (rawToken === getStoredJwtToken() || adoptedToken === rawToken) return;
    adoptedToken = rawToken;

    void (async () => {
      const previousUid = getJwtUid(getStoredJwtToken());

      try {
        const refreshedToken = await refreshSessionToken(rawToken);

        await commitJwtToken(refreshedToken);

        const nextUid = getJwtUid(refreshedToken);
        if (previousUid == null || nextUid == null || nextUid !== previousUid) {
          window.location.reload();
        }
      } catch (error) {
        if (adoptedToken === rawToken) {
          adoptedToken = null;
        }
        console.warn('[auth] rejected query token', error);
      }
    })();
  }, [history, isLandingRouteExact, location.hash, location.pathname, location.search, location.state]);
}
