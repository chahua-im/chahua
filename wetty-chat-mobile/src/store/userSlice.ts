import type { PayloadAction } from '@reduxjs/toolkit';
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { usersApi } from '@/api/users';
import type { UserGroupTagInfo } from '@/api/messages';

export interface UserState {
  uid: number | null;
  username: string | null;
  avatarUrl: string | null;
  gender: number;
  userGroup: UserGroupTagInfo | null;
  permissions: string[];
  loading: boolean;
  error: string | null;
}

const initialState: UserState = {
  uid: null,
  username: null,
  avatarUrl: null,
  gender: 0,
  userGroup: null,
  permissions: [],
  loading: true,
  error: null,
};

export const fetchCurrentUser = createAsyncThunk('user/fetchCurrentUser', async (_, { rejectWithValue }) => {
  try {
    return await usersApi.getCurrentUser();
  } catch (err: any) {
    return rejectWithValue(err.response?.data || err.message);
  }
});

const userSlice = createSlice({
  name: 'user',
  initialState,
  reducers: {
    setUser(
      state,
      action: PayloadAction<{
        uid: number;
        username: string;
        avatarUrl: string | null;
        gender?: number;
        userGroup?: UserGroupTagInfo | null;
        permissions?: string[];
      }>,
    ) {
      state.uid = action.payload.uid;
      state.username = action.payload.username;
      state.avatarUrl = action.payload.avatarUrl;
      state.gender = action.payload.gender ?? 0;
      state.userGroup = action.payload.userGroup ?? null;
      state.permissions = action.payload.permissions ?? [];
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCurrentUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        state.loading = false;
        state.uid = action.payload.uid;
        state.username = action.payload.username;
        state.avatarUrl = action.payload.avatarUrl ?? null;
        state.gender = action.payload.gender;
        state.userGroup = action.payload.userGroup ?? null;
        state.permissions = action.payload.permissions ?? [];
      })
      .addCase(fetchCurrentUser.rejected, (state, action) => {
        state.loading = false;
        state.error = (action.payload as string) || 'Failed to fetch user';
        state.permissions = [];
      });
  },
});

export const { setUser } = userSlice.actions;

export const selectCurrentUser = (state: RootState) => state.user;

export default userSlice.reducer;
