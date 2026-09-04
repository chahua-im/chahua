import { configureStore } from '@reduxjs/toolkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockResponse } from '@/api/blocks';
import { friendsApi, type FriendRequestHistoryEntry, type FriendResponse } from '@/api/friends';
import type { RootState } from './index';
import reducer, { blockAdded, fetchFriends, fetchPendingRequests, selectPendingIncomingCount } from './socialSlice';

const user = { uid: 2, username: 'Bob', gender: 0 };
const friend: FriendResponse = { user, since: '2026-08-18T00:00:00Z' };
const block: BlockResponse = { user, since: '2026-08-18T01:00:00Z' };
const incomingRequest: FriendRequestHistoryEntry = {
  id: 'incoming-request',
  from: user,
  to: { uid: 1, username: 'Alice', gender: 0 },
  status: 'pending',
  createdAt: '2026-08-18T02:00:00Z',
  decidedAt: null,
  direction: 'incoming',
};
const outgoingRequest: FriendRequestHistoryEntry = {
  id: 'outgoing-request',
  from: { uid: 1, username: 'Alice', gender: 0 },
  to: { uid: 3, username: 'Cara', gender: 0 },
  status: 'pending',
  createdAt: '2026-08-18T01:00:00Z',
  decidedAt: null,
  direction: 'outgoing',
};
afterEach(() => vi.restoreAllMocks());

describe('socialSlice blocking', () => {
  it('preserves an existing friendship when a block is added', () => {
    let state = reducer(undefined, fetchFriends.fulfilled([friend], 'friends-request', undefined));

    state = reducer(state, blockAdded(block));

    expect(state.blocks).toEqual([block]);
    expect(state.friends).toEqual([friend]);
  });
});

describe('socialSlice pending requests', () => {
  it('loads pending requests and derives the incoming badge count', async () => {
    const listRequests = vi
      .spyOn(friendsApi, 'listRequestHistory')
      .mockResolvedValueOnce([incomingRequest, outgoingRequest]);
    const store = configureStore({ reducer: { social: reducer } });

    await store.dispatch(fetchPendingRequests());

    expect(listRequests).toHaveBeenCalledWith('pending');
    expect(store.getState().social.pendingRequests).toEqual([incomingRequest, outgoingRequest]);
    expect(selectPendingIncomingCount(store.getState() as RootState)).toBe(1);
  });
});
