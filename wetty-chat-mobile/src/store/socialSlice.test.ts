import { describe, expect, it } from 'vitest';
import type { BlockResponse } from '@/api/blocks';
import type { FriendResponse } from '@/api/friends';
import reducer, { blockAdded, fetchFriends } from './socialSlice';

const user = { uid: 2, username: 'Bob', gender: 0 };
const friend: FriendResponse = { user, since: '2026-08-18T00:00:00Z' };
const block: BlockResponse = { user, since: '2026-08-18T01:00:00Z' };

describe('socialSlice blocking', () => {
  it('preserves an existing friendship when a block is added', () => {
    let state = reducer(undefined, fetchFriends.fulfilled([friend], 'friends-request', undefined));

    state = reducer(state, blockAdded(block));

    expect(state.blocks).toEqual([block]);
    expect(state.friends).toEqual([friend]);
  });
});
