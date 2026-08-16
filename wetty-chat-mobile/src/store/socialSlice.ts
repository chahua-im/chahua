import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { friendsApi, type FriendRequestResponse, type FriendResponse } from '@/api/friends';
import { blocksApi, type BlockResponse } from '@/api/blocks';
import type { RootState } from './index';

interface SocialState {
  friends: FriendResponse[];
  friendsLoaded: boolean;
  incomingRequests: FriendRequestResponse[];
  outgoingRequests: FriendRequestResponse[];
  requestsLoaded: boolean;
  blocks: BlockResponse[];
  blocksLoaded: boolean;
}

const initialState: SocialState = {
  friends: [],
  friendsLoaded: false,
  incomingRequests: [],
  outgoingRequests: [],
  requestsLoaded: false,
  blocks: [],
  blocksLoaded: false,
};

export const fetchFriends = createAsyncThunk('social/fetchFriends', async () => {
  return await friendsApi.listFriends();
});

export const fetchIncomingRequests = createAsyncThunk('social/fetchIncomingRequests', async () => {
  return await friendsApi.listIncomingRequests();
});

export const fetchOutgoingRequests = createAsyncThunk('social/fetchOutgoingRequests', async () => {
  return await friendsApi.listOutgoingRequests();
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
    outgoingRequestAdded(state, action: PayloadAction<FriendRequestResponse>) {
      if (!state.outgoingRequests.some((r) => r.id === action.payload.id)) {
        state.outgoingRequests.unshift(action.payload);
      }
    },
    outgoingRequestRemoved(state, action: PayloadAction<string>) {
      state.outgoingRequests = state.outgoingRequests.filter((r) => r.id !== action.payload);
    },
    incomingRequestRemoved(state, action: PayloadAction<string>) {
      state.incomingRequests = state.incomingRequests.filter((r) => r.id !== action.payload);
    },
    blockAdded(state, action: PayloadAction<BlockResponse>) {
      if (!state.blocks.some((b) => b.user.uid === action.payload.user.uid)) {
        state.blocks.unshift(action.payload);
      }
      // Blocking tears down the friendship on the server side; mirror locally.
      state.friends = state.friends.filter((f) => f.user.uid !== action.payload.user.uid);
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
      .addCase(fetchIncomingRequests.fulfilled, (state, action) => {
        state.incomingRequests = action.payload;
        state.requestsLoaded = true;
      })
      .addCase(fetchOutgoingRequests.fulfilled, (state, action) => {
        state.outgoingRequests = action.payload;
        state.requestsLoaded = true;
      })
      .addCase(fetchBlocks.fulfilled, (state, action) => {
        state.blocks = action.payload;
        state.blocksLoaded = true;
      });
  },
});

export const {
  friendAdded,
  friendRemoved,
  outgoingRequestAdded,
  outgoingRequestRemoved,
  incomingRequestRemoved,
  blockAdded,
  blockRemoved,
} = socialSlice.actions;

export const selectFriends = (state: RootState): FriendResponse[] => state.social.friends;
export const selectFriendsLoaded = (state: RootState): boolean => state.social.friendsLoaded;
export const selectIncomingRequests = (state: RootState): FriendRequestResponse[] => state.social.incomingRequests;
export const selectOutgoingRequests = (state: RootState): FriendRequestResponse[] => state.social.outgoingRequests;
export const selectRequestsLoaded = (state: RootState): boolean => state.social.requestsLoaded;
export const selectBlocks = (state: RootState): BlockResponse[] => state.social.blocks;
export const selectBlocksLoaded = (state: RootState): boolean => state.social.blocksLoaded;

export const selectIsFriend = (state: RootState, uid: number): boolean =>
  state.social.friends.some((f) => f.user.uid === uid);

export const selectIsBlocked = (state: RootState, uid: number): boolean =>
  state.social.blocks.some((b) => b.user.uid === uid);

export const selectIncomingRequestFrom = (state: RootState, uid: number): FriendRequestResponse | undefined =>
  state.social.incomingRequests.find((r) => r.from.uid === uid);

export const selectOutgoingRequestTo = (state: RootState, uid: number): FriendRequestResponse | undefined =>
  state.social.outgoingRequests.find((r) => r.to.uid === uid);

export default socialSlice.reducer;
