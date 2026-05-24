import { useEffect } from 'react';
import { syncApp } from '@/api/sync';
import {
  ensureWebSocketConnected,
  handleWebSocketOffline,
  handleWebSocketOnline,
  setWebSocketAppState,
  type WebSocketAppState,
} from '@/api/ws';
import { isPageHidden } from '@/utils/dom';

function getAppLifecycleState(): WebSocketAppState {
  if (typeof document === 'undefined') return 'active';
  return isPageHidden() ? 'inactive' : 'active';
}

export function useAppLifecycle(): void {
  useEffect(() => {
    const applyLifecycleState = () => {
      const state = getAppLifecycleState();
      setWebSocketAppState(state);

      if (state === 'active') {
        syncApp();
        ensureWebSocketConnected();
      }
    };

    const handleOnline = () => {
      handleWebSocketOnline();
      syncApp();
    };

    const handleOffline = () => {
      handleWebSocketOffline();
    };

    applyLifecycleState();

    document.addEventListener('visibilitychange', applyLifecycleState);
    window.addEventListener('focus', applyLifecycleState);
    window.addEventListener('blur', applyLifecycleState);
    window.addEventListener('pageshow', applyLifecycleState);
    window.addEventListener('pagehide', applyLifecycleState);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      document.removeEventListener('visibilitychange', applyLifecycleState);
      window.removeEventListener('focus', applyLifecycleState);
      window.removeEventListener('blur', applyLifecycleState);
      window.removeEventListener('pageshow', applyLifecycleState);
      window.removeEventListener('pagehide', applyLifecycleState);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
}
