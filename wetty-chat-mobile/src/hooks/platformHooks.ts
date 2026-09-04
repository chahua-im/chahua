import { isPlatform } from '@ionic/react';
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { isFeatureEnabled } from '@/features';
import { selectColorMode } from '@/store/settingsSlice';
import { resolveDarkMode } from '@/utils/colorMode';

const DESKTOP_QUERY = '(min-width: 900px)';
const HOVER_FINE_POINTER_QUERY = '(any-hover: hover) and (any-pointer: fine)';

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isDesktop;
}

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';

function useSystemDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() => window.matchMedia(DARK_MODE_QUERY).matches);

  useEffect(() => {
    const mq = window.matchMedia(DARK_MODE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isDarkMode;
}

export function useIsDarkMode(): boolean {
  const systemDarkMode = useSystemDarkMode();
  const colorMode = useSelector(selectColorMode);

  return isFeatureEnabled('colorMode') ? resolveDarkMode(colorMode, systemDarkMode) : systemDarkMode;
}

export function useIsPWA(): boolean {
  const [isPWA, setIsPWA] = useState(() => (typeof window !== 'undefined' ? isPlatform('pwa') : false));

  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia == null) {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const updateIsPWA = () => {
      setIsPWA(mediaQuery.matches || isPlatform('pwa'));
    };

    updateIsPWA();
    mediaQuery.addEventListener('change', updateIsPWA);

    return () => {
      mediaQuery.removeEventListener('change', updateIsPWA);
    };
  }, []);

  return isPWA;
}

export function useMouseDetected(): boolean {
  const [mouseDetected, setMouseDetected] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(HOVER_FINE_POINTER_QUERY).matches : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia(HOVER_FINE_POINTER_QUERY);
    const updateMouseDetected = () => {
      setMouseDetected(mediaQuery.matches);
    };

    updateMouseDetected();
    mediaQuery.addEventListener('change', updateMouseDetected);

    return () => {
      mediaQuery.removeEventListener('change', updateMouseDetected);
    };
  }, []);

  return mouseDetected;
}
