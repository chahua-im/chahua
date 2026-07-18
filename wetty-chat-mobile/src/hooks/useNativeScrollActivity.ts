import { useCallback, useEffect, useRef, useState } from 'react';

export function useNativeScrollActivity(graceMs = 1200, idleMs = 200) {
  const [active, setActive] = useState(false);
  const userUntilRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      setActive(false);
      idleTimerRef.current = null;
    }, idleMs);
  }, [idleMs]);

  // Bound to wheel/touch/pointer input — marks the start of a user-driven
  // interaction and (re)starts the idle countdown.
  const markIntent = useCallback(() => {
    userUntilRef.current = performance.now() + graceMs;
    setActive(true);
    resetIdleTimer();
  }, [graceMs, resetIdleTimer]);

  // Called from the component's own scroll handler so we keep a SINGLE scroll
  // listener instead of registering a second native addEventListener('scroll').
  // `isTrusted` mirrors the previous native path: real user scrolls are trusted,
  // programmatic scrollTop changes are not. See plan P0-3.
  const notifyScroll = useCallback(
    (isTrusted: boolean) => {
      const isUser = isTrusted || performance.now() <= userUntilRef.current;
      setActive(isUser);
      resetIdleTimer();
    },
    [resetIdleTimer],
  );

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, []);

  return { active, markIntent, notifyScroll };
}
