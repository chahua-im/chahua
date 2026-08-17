import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { listPins, listThreadPins } from '@/api/pins';
import type { RootState } from '@/store';
import { pinScopeKey, selectPinsForScope, selectPinsLoadedForScope, setPins } from '@/store/pinsSlice';

interface UseChatPinsArgs {
  chatId: string;
  threadId?: string;
}

export function useChatPins({ chatId, threadId }: UseChatPinsArgs) {
  const dispatch = useDispatch();
  const scopeKey = pinScopeKey(chatId, threadId);
  const pins = useSelector((state: RootState) => selectPinsForScope(state, scopeKey));
  const pinsLoaded = useSelector((state: RootState) => selectPinsLoadedForScope(state, scopeKey));
  const [pinListOpen, setPinListOpen] = useState(false);

  useEffect(() => {
    if (pinsLoaded) return;

    (threadId ? listThreadPins(chatId, threadId) : listPins(chatId))
      .then((res) => dispatch(setPins({ chatId, threadRootId: threadId, pins: res.data.pins })))
      .catch(() => {});
  }, [chatId, threadId, pinsLoaded, dispatch]);

  const openPinList = useCallback(() => {
    setPinListOpen(true);
  }, []);

  const closePinList = useCallback(() => {
    setPinListOpen(false);
  }, []);

  return {
    pins,
    scopeKey,
    pinListOpen,
    openPinList,
    closePinList,
  };
}
