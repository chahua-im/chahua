import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from './index';

export interface UploadProgressState {
  byClientId: Record<string, number>;
}

const initialState: UploadProgressState = {
  byClientId: {},
};

const uploadProgressSlice = createSlice({
  name: 'uploadProgress',
  initialState,
  reducers: {
    uploadProgressSet(state, action: PayloadAction<{ clientGeneratedId: string; progress: number }>) {
      state.byClientId[action.payload.clientGeneratedId] = action.payload.progress;
    },
    uploadProgressCleared(state, action: PayloadAction<{ clientGeneratedId: string }>) {
      delete state.byClientId[action.payload.clientGeneratedId];
    },
  },
});

export const { uploadProgressSet, uploadProgressCleared } = uploadProgressSlice.actions;

export function selectUploadProgress(
  state: RootState,
  clientGeneratedId: string | null | undefined,
): number | undefined {
  return clientGeneratedId ? state.uploadProgress.byClientId[clientGeneratedId] : undefined;
}

export default uploadProgressSlice.reducer;
