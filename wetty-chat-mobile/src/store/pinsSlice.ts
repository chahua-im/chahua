import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice } from '@reduxjs/toolkit';
import { messagePatched } from './messageEvents';
import type { RootState } from './index';
import type { PinResponse } from '@/api/pins';

interface ChatPins {
  pins: PinResponse[];
  loaded: boolean;
}

export interface PinsState {
  byScope: Record<string, ChatPins>;
  /** Per-user banner dismissal: pin scope key -> dismissed pin ID */
  dismissedPinId: Record<string, string>;
}

/**
 * Chat pins and each thread's pins are independent lists. Threads reuse the
 * `${chatId}_thread_${threadRootId}` composite key format used elsewhere for
 * thread-scoped state.
 */
export function pinScopeKey(chatId: string, threadRootId?: string | null): string {
  return threadRootId ? `${chatId}_thread_${threadRootId}` : chatId;
}

const initialState: PinsState = {
  byScope: {},
  dismissedPinId: {},
};

const pinsSlice = createSlice({
  name: 'pins',
  initialState,
  reducers: {
    setPins(state, action: PayloadAction<{ chatId: string; threadRootId?: string | null; pins: PinResponse[] }>) {
      const sortedPins = [...action.payload.pins].sort(
        (a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
      );
      state.byScope[pinScopeKey(action.payload.chatId, action.payload.threadRootId)] = {
        pins: sortedPins,
        loaded: true,
      };
    },
    addPin(state, action: PayloadAction<PinResponse>) {
      const scopeKey = pinScopeKey(action.payload.chatId, action.payload.threadRootId);
      const entry = state.byScope[scopeKey];
      if (entry) {
        // Avoid duplicates
        if (!entry.pins.some((p) => p.id === action.payload.id)) {
          entry.pins.push(action.payload);
          entry.pins.sort((a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime());
        }
      } else {
        state.byScope[scopeKey] = { pins: [action.payload], loaded: true };
      }
      // Clear dismissed state so new pin shows in banner
      delete state.dismissedPinId[scopeKey];
    },
    removePin(state, action: PayloadAction<{ chatId: string; threadRootId?: string | null; pinId: string }>) {
      const entry = state.byScope[pinScopeKey(action.payload.chatId, action.payload.threadRootId)];
      if (entry) {
        entry.pins = entry.pins.filter((p) => p.id !== action.payload.pinId);
      }
    },
    dismissBanner(state, action: PayloadAction<{ chatId: string; threadRootId?: string | null; pinId: string }>) {
      state.dismissedPinId[pinScopeKey(action.payload.chatId, action.payload.threadRootId)] = action.payload.pinId;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(messagePatched, (state, action) => {
      const { chatId, messageId, message } = action.payload;
      // The same message can be pinned chat-wide and inside a thread, so patch
      // every scope of this chat rather than a single entry.
      for (const entry of Object.values(state.byScope)) {
        for (let i = 0; i < entry.pins.length; i++) {
          const pin = entry.pins[i];
          if (pin.chatId !== chatId || pin.message.id !== messageId) continue;
          if (message.isDeleted) {
            pin.message = { ...pin.message, isDeleted: true, message: null };
          } else {
            pin.message = {
              ...pin.message,
              message: message.message,
              messageType: message.messageType,
              isEdited: message.isEdited,
              attachments: message.attachments,
              hasAttachments: message.hasAttachments,
              mentions: message.mentions,
              sticker: message.sticker,
            };
          }
        }
      }
    });
  },
});

export const { setPins, addPin, removePin, dismissBanner } = pinsSlice.actions;

export const selectPinsForScope = (state: RootState, scopeKey: string): PinResponse[] =>
  state.pins.byScope[scopeKey]?.pins ?? [];

export const selectPinsLoadedForScope = (state: RootState, scopeKey: string): boolean =>
  state.pins.byScope[scopeKey]?.loaded ?? false;

export const selectLatestPinForScope = (state: RootState, scopeKey: string): PinResponse | null =>
  state.pins.byScope[scopeKey]?.pins[0] ?? null;

export const selectIsBannerDismissedForScope = (state: RootState, scopeKey: string): boolean => {
  const latestPin = state.pins.byScope[scopeKey]?.pins[0];
  if (!latestPin) return true;
  return state.pins.dismissedPinId[scopeKey] === latestPin.id;
};

export default pinsSlice.reducer;
