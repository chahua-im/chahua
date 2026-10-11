import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageResponse } from '@/api/messages';

export interface OverlayRequest {
  message: MessageResponse;
  sourceRect: DOMRect;
  interactionPos?: { x: number; y: number };
}

interface UseMessageOverlayCoordinatorOptions {
  isKeyboardOpen: boolean;
  keyboardFullyClosed: boolean;
  dismissKeyboard: () => void;
}

interface MessageOverlayCoordinator {
  overlayMessage: OverlayRequest | null;
  /** Returns false (and changes nothing) when a transaction already owns the message identity. */
  requestOverlay: (request: OverlayRequest) => boolean;
  closeOverlay: () => void;
}

// One long-press gesture is one message-identity transaction. The first accepted
// request locks the message until the overlay closes. While the soft keyboard
// closes the page reflows mid-gesture, so the browser's native contextmenu fires
// later against whichever bubble now sits under the finger — those late requests
// (from any bubble) must never re-select the message. Two lifecycles live here:
// the active transaction (lock) and the deferred payload waiting for the
// keyboard to close; consuming the latter must not release the former.
export function useMessageOverlayCoordinator({
  isKeyboardOpen,
  keyboardFullyClosed,
  dismissKeyboard,
}: UseMessageOverlayCoordinatorOptions): MessageOverlayCoordinator {
  const [overlayMessage, setOverlayMessage] = useState<OverlayRequest | null>(null);
  // Refs instead of state so adjacent events of the same gesture read the lock
  // without racing React's commit.
  const activeLongPressRef = useRef<OverlayRequest | null>(null);
  const deferredRequestRef = useRef<OverlayRequest | null>(null);

  const requestOverlay = useCallback(
    (request: OverlayRequest): boolean => {
      if (activeLongPressRef.current) {
        return false;
      }

      activeLongPressRef.current = request;
      if (isKeyboardOpen) {
        deferredRequestRef.current = request;
        dismissKeyboard();
        return true;
      }

      setOverlayMessage(request);
      return true;
    },
    [isKeyboardOpen, dismissKeyboard],
  );

  useEffect(() => {
    if (!keyboardFullyClosed || !deferredRequestRef.current) return;
    const request = deferredRequestRef.current;
    deferredRequestRef.current = null;
    setOverlayMessage(request);
  }, [keyboardFullyClosed]);

  const closeOverlay = useCallback(() => {
    deferredRequestRef.current = null;
    activeLongPressRef.current = null;
    setOverlayMessage(null);
  }, []);

  useEffect(() => {
    return () => {
      deferredRequestRef.current = null;
      activeLongPressRef.current = null;
    };
  }, []);

  return { overlayMessage, requestOverlay, closeOverlay };
}
