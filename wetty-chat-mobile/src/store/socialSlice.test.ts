import { describe, expect, it } from 'vitest';
import type { BlockResponse } from '@/api/blocks';
import type { FriendRequestHistoryEntry, FriendResponse } from '@/api/friends';
import reducer, { blockAdded, fetchFriends, fetchPendingIncomingCount, fetchRequestHistory } from './socialSlice';

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
const resolvedIncomingRequest: FriendRequestHistoryEntry = {
  id: 'resolved-incoming-request',
  from: { uid: 4, username: 'Dan', gender: 0 },
  to: { uid: 1, username: 'Alice', gender: 0 },
  status: 'accepted',
  createdAt: '2026-08-18T00:00:00Z',
  decidedAt: '2026-08-18T01:00:00Z',
  direction: 'incoming',
};

describe('socialSlice blocking', () => {
  it('preserves an existing friendship when a block is added', () => {
    let state = reducer(undefined, fetchFriends.fulfilled([friend], 'friends-request', undefined));

    state = reducer(state, blockAdded(block));

    expect(state.blocks).toEqual([block]);
    expect(state.friends).toEqual([friend]);
  });
});

describe('socialSlice request hydration', () => {
  it('stores request history and derives the pending incoming badge count', () => {
    let state = reducer(
      undefined,
      fetchRequestHistory.fulfilled(
        [incomingRequest, outgoingRequest, resolvedIncomingRequest],
        'history-request',
        undefined,
      ),
    );

    expect(state.requestHistoryLoaded).toBe(true);
    expect(state.pendingIncomingCount).toBe(1);

    state = reducer(state, fetchPendingIncomingCount.fulfilled(7, 'pending-count-request', undefined));

    expect(state.pendingIncomingCount).toBe(7);
  });
});
