import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from './index';

/**
 * The message id currently highlighted after a jump (reply preview, pinned
 * banner, last-read resume). Set by `jumpToMessage`; cleared ~2s later by a
 * timer. Bubbles subscribe via `selectHighlightedMessageId` to add a `.focused`
 * class — declarative, like telegram-tt's `focusedMessage` Redux state.
 *
 * Note: no `chatId` scoping — only one message can be highlighted app-wide at a
 * time, and a highlight left over from another chat is harmless (that chat's
 * bubbles simply won't render until opened). Keeping the state minimal.
 */
interface HighlightState {
  messageId: string | null;
}

const initialState: HighlightState = {
  messageId: null,
};

const highlightSlice = createSlice({
  name: 'highlight',
  initialState,
  reducers: {
    setMessageHighlight(state, action: PayloadAction<string>) {
      state.messageId = action.payload;
    },
    clearMessageHighlight(state) {
      state.messageId = null;
    },
  },
});

export const { setMessageHighlight, clearMessageHighlight } = highlightSlice.actions;

export const selectHighlightedMessageId = (state: RootState): string | null => state.highlight.messageId;

export default highlightSlice.reducer;
