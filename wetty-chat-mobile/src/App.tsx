import { IonApp, IonToast } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Redirect, useHistory, useLocation, useRouteMatch } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { useEffect, useRef } from 'react';
import type { AppDispatch } from '@/store/index';
import { fetchCurrentUser } from '@/store/userSlice';
import './app.scss';
import { t } from '@lingui/core/macro';
import { isFeatureEnabled } from '@/features';
import MobileLayout from './layouts/MobileLayout';
import { AppUpdateProvider } from './hooks/AppUpdateProvider';
import { useIsDesktop } from './hooks/platformHooks';
import { useAppLifecycle } from './hooks/useAppLifecycle';
import { useAppUpdate } from './hooks/useAppUpdate';
import { usePushNotificationBootstrap } from './hooks/usePushNotifications';
import { DesktopSplitLayout } from './layouts/DesktopSplitLayout';
import OobePage from '@/pages/oobe';
import LandingPage from './pages/landing';
import PushOpenPage from '@/pages/push-open';
import ProfileDeepLinkPage from '@/pages/profile';
import { ProfileDeepLinkHost } from '@/components/social/ProfileDeepLinkHost';
import { PendingInviteModalHost } from '@/components/invites/PendingInviteModalHost';
import PermalinkPage from '@/pages/permalink';
import { initWebSocket } from '@/api/ws';
import { appHistory } from '@/utils/navigationHistory';
import { useNotificationOpenHandler } from '@/hooks/useNotificationOpenHandler';
import { useQueryTokenAdoption } from '@/hooks/useQueryTokenAdoption';

const OOBE_STORAGE_KEY = 'oobe';

const PROFILE_DEEP_LINK_ENABLED = isFeatureEnabled('profileDeepLink');

function hasCompletedOobe() {
  return localStorage.getItem(OOBE_STORAGE_KEY) !== null;
}

/**
 * Strip desktop-only route state (backgroundPath) when switching from desktop
 * to mobile layout.  Without this, stale modal state left in the history entry
 * has no consumer on mobile and can confuse future navigations.
 */
function useLayoutTransitionCleanup(isDesktop: boolean) {
  const history = useHistory();
  const location = useLocation<{ backgroundPath?: string } | undefined>();
  const prevIsDesktop = useRef(isDesktop);

  useEffect(() => {
    const wasDesktop = prevIsDesktop.current;
    prevIsDesktop.current = isDesktop;

    // Only clean up when transitioning from desktop → mobile
    if (wasDesktop && !isDesktop && location.state?.backgroundPath) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { backgroundPath, ...rest } = location.state;
      history.replace({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: Object.keys(rest).length > 0 ? rest : undefined,
      });
    }
  }, [isDesktop, history, location]);
}

function QueryTokenAdopter() {
  useQueryTokenAdoption();
  return null;
}

function AppRouter({ isDesktop }: { isDesktop: boolean }) {
  useLayoutTransitionCleanup(isDesktop);
  const isOobeRoute = useRouteMatch('/oobe');
  const isLandingRoute = useRouteMatch('/landing');
  const isPushOpenRoute = useRouteMatch('/push-open');
  const isProfileRoute = useRouteMatch('/profile');
  const isPermalinkRoute = useRouteMatch<{ encoded: string }>('/m/:encoded');

  if (isLandingRoute?.isExact) {
    return <LandingPage />;
  } else if (isOobeRoute?.isExact) {
    return <OobePage />;
  } else if (isPushOpenRoute?.isExact) {
    return <PushOpenPage />;
  } else if (PROFILE_DEEP_LINK_ENABLED && isProfileRoute?.isExact) {
    return <ProfileDeepLinkPage />;
  } else if (isPermalinkRoute) {
    return <PermalinkPage encoded={isPermalinkRoute.params.encoded} />;
  } else if (!hasCompletedOobe()) {
    return <Redirect to="/oobe" />;
  }

  return (
    <>
      {isDesktop ? <DesktopSplitLayout /> : <MobileLayout />}
      <PendingInviteModalHost />
      {PROFILE_DEEP_LINK_ENABLED && <ProfileDeepLinkHost />}
    </>
  );
}

function AppShell() {
  const dispatch = useDispatch<AppDispatch>();
  const isDesktop = useIsDesktop();
  useAppLifecycle();
  usePushNotificationBootstrap();
  useNotificationOpenHandler();
  const { needRefresh, setNeedRefresh, updateServiceWorker } = useAppUpdate();

  useEffect(() => {
    initWebSocket();
    dispatch(fetchCurrentUser());
  }, [dispatch]);

  return (
    <IonApp>
      <IonToast
        isOpen={needRefresh}
        message={t`A new version of the app is available!`}
        position="bottom"
        duration={0}
        buttons={[
          {
            text: t`Update Now`,
            role: 'info',
            handler: () => updateServiceWorker(true),
          },
          {
            text: t`Dismiss`,
            role: 'cancel',
            handler: () => setNeedRefresh(false),
          },
        ]}
      />
      <div className="app-router-shell">
        <IonReactRouter history={appHistory}>
          <QueryTokenAdopter />
          <AppRouter isDesktop={isDesktop} />
        </IonReactRouter>
      </div>
    </IonApp>
  );
}

const App: React.FC = () => {
  return (
    <AppUpdateProvider>
      <AppShell />
    </AppUpdateProvider>
  );
};

export default App;
