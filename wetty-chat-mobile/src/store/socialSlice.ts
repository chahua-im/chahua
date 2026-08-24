import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { friendsApi, type FriendRequestHistoryEntry, type FriendResponse } from '@/api/friends';
import { blocksApi, type BlockResponse } from '@/api/blocks';
import type { RootState } from './index';

interface SocialState {
  friends: FriendResponse[];
  friendsLoaded: boolean;
  requestHistory: FriendRequestHistoryEntry[];
  requestHistoryLoaded: boolean;
  pendingIncomingCount: number;
  blocks: BlockResponse[];
  blocksLoaded: boolean;
}

const initialState: SocialState = {
  friends: [],
  friendsLoaded: false,
  requestHistory: [],
  requestHistoryLoaded: false,
  pendingIncomingCount: 0,
  blocks: [],
  blocksLoaded: false,
};

export const fetchFriends = createAsyncThunk('social/fetchFriends', async () => {
  return await friendsApi.listFriends();
});

export const fetchRequestHistory = createAsyncThunk('social/fetchRequestHistory', async () => {
  return await friendsApi.listRequestHistory();
});

export const fetchPendingIncomingCount = createAsyncThunk('social/fetchPendingIncomingCount', async () => {
  return await friendsApi.getPendingIncomingCount();
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
      .addCase(fetchRequestHistory.fulfilled, (state, action) => {
        state.requestHistory = action.payload;
        state.requestHistoryLoaded = true;
        // History is authoritative for the badge at this instant.
        state.pendingIncomingCount = action.payload.filter(
          (request) => request.direction === 'incoming' && request.status === 'pending',
        ).length;
      })
      .addCase(fetchPendingIncomingCount.fulfilled, (state, action) => {
        state.pendingIncomingCount = action.payload;
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
export const selectRequestHistory = (state: RootState): FriendRequestHistoryEntry[] => state.social.requestHistory;
export const selectRequestHistoryLoaded = (state: RootState): boolean => state.social.requestHistoryLoaded;
export const selectPendingIncomingCount = (state: RootState): number => state.social.pendingIncomingCount;
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
  state.social.requestHistory.find(
    (request) => request.direction === 'incoming' && request.status === 'pending' && request.from.uid === uid,
  );

export const selectPendingOutgoingRequestTo = (state: RootState, uid: number): FriendRequestHistoryEntry | undefined =>
  state.social.requestHistory.find(
    (request) => request.direction === 'outgoing' && request.status === 'pending' && request.to.uid === uid,
  );

export default socialSlice.reducer;
