import { useEffect, useRef } from 'react';
import { isPageHidden } from '@/utils/dom';

/**
 * Calls `callback` whenever the page transitions from hidden to visible
 * (tab switch, window focus).  The callback is NOT called on mount — only on
 * subsequent visibility transitions — so it is safe for side-effect-only work
 * like flushing pending state.
 */
export function usePageVisible(callback: () => void): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    const onVisible = () => {
      if (!isPageHidden()) callbackRef.current();
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);
}
