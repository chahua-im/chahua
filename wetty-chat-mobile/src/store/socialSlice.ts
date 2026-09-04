import { createAsyncThunk, createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { friendsApi, type FriendRequestHistoryEntry, type FriendResponse } from '@/api/friends';
import { blocksApi, type BlockResponse } from '@/api/blocks';
import type { RootState } from './index';

interface SocialState {
  friends: FriendResponse[];
  friendsLoaded: boolean;
  pendingRequests: FriendRequestHistoryEntry[];
  blocks: BlockResponse[];
  blocksLoaded: boolean;
}

const initialState: SocialState = {
  friends: [],
  friendsLoaded: false,
  pendingRequests: [],
  blocks: [],
  blocksLoaded: false,
};

export const fetchFriends = createAsyncThunk('social/fetchFriends', async () => {
  return await friendsApi.listFriends();
});

export const fetchPendingRequests = createAsyncThunk('social/fetchPendingRequests', async () => {
  return await friendsApi.listRequestHistory('pending');
});

export const fetchBlocks = createAsyncThunk('social/fetchBlocks', async () => {
  return await blocksApi.listBlocks();
});

const socialSlice = createSlice({
  name: 'social',
  initialState,
  reducers: {
    friendAdded(state, action: PayloadAction<FriendResponse>) {
      if (!state.friends.some((f) => f.user.uid === action.payload.user.uid)) {
        state.friends.push(action.payload);
      }
    },
    friendRemoved(state, action: PayloadAction<number>) {
      state.friends = state.friends.filter((f) => f.user.uid !== action.payload);
    },
    blockAdded(state, action: PayloadAction<BlockResponse>) {
      if (!state.blocks.some((b) => b.user.uid === action.payload.user.uid)) {
        state.blocks.unshift(action.payload);
      }
    },
    blockRemoved(state, action: PayloadAction<number>) {
      state.blocks = state.blocks.filter((b) => b.user.uid !== action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchFriends.fulfilled, (state, action) => {
        state.friends = action.payload;
        state.friendsLoaded = true;
      })
      .addCase(fetchPendingRequests.fulfilled, (state, action) => {
        state.pendingRequests = action.payload;
      })
      .addCase(fetchBlocks.fulfilled, (state, action) => {
        state.blocks = action.payload;
        state.blocksLoaded = true;
      });
  },
});

export const { friendAdded, friendRemoved, blockAdded, blockRemoved } = socialSlice.actions;

export const selectFriends = (state: RootState): FriendResponse[] => state.social.friends;
export const selectFriendsLoaded = (state: RootState): boolean => state.social.friendsLoaded;
export const selectPendingRequests = (state: RootState): FriendRequestHistoryEntry[] => state.social.pendingRequests;
export const selectPendingIncomingCount = createSelector(
  [selectPendingRequests],
  (requests) => requests.filter((request) => request.direction === 'incoming').length,
);
export const selectBlocks = (state: RootState): BlockResponse[] => state.social.blocks;
export const selectBlocksLoaded = (state: RootState): boolean => state.social.blocksLoaded;

export const selectIsFriend = (state: RootState, uid: number): boolean =>
  state.social.friends.some((f) => f.user.uid === uid);

export const selectIsBlocked = (state: RootState, uid: number): boolean =>
  state.social.blocks.some((b) => b.user.uid === uid);

export const selectPendingIncomingRequestFrom = (
  state: RootState,
  uid: number,
): FriendRequestHistoryEntry | undefined =>
  state.social.pendingRequests.find((request) => request.direction === 'incoming' && request.from.uid === uid);

export const selectPendingOutgoingRequestTo = (state: RootState, uid: number): FriendRequestHistoryEntry | undefined =>
  state.social.pendingRequests.find((request) => request.direction === 'outgoing' && request.to.uid === uid);

export default socialSlice.reducer;
