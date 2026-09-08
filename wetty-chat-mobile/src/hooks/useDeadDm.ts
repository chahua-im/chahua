import { useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '@/store';
import {
  fetchBlocks,
  fetchFriends,
  selectBlocksLoaded,
  selectFriendsLoaded,
  selectIsBlocked,
  selectIsFriend,
} from '@/store/socialSlice';
import { useFeatureGate } from '@/hooks/useFeatureGate';

interface UseDeadDmArgs {
  isDm: boolean;
  /** The other DM participant; absent while chat metadata is loading. */
  peerUid: number | undefined;
}

interface UseDeadDmResult {
  /**
   * A DM whose friendship has ended (unfriended or blocked either way) is
   * read-only: the history stays visible, but pins, replies, threads, edits,
   * deletions, reactions, and new messages are all disabled — mirroring the
   * backend's `require_chat_writable` gate.
   */
  deadDm: boolean;
  /** True when deadDm and the cause is a block; picks the compose reason copy. */
  blockedCause: boolean;
}

/**
 * Lazily hydrates the friends/blocks lists so the flag reflects server truth
 * even when entering a DM without visiting Contacts.
 */
export function useDeadDm({ isDm, peerUid }: UseDeadDmArgs): UseDeadDmResult {
  const dispatch = useDispatch<AppDispatch>();
  const friendsEnabled = useFeatureGate('friends');
  const blockEnabled = useFeatureGate('userBlock');

  const isFriend = useSelector((state: RootState) =>
    friendsEnabled && peerUid ? selectIsFriend(state, peerUid) : false,
  );
  const isBlocked = useSelector((state: RootState) =>
    blockEnabled && peerUid ? selectIsBlocked(state, peerUid) : false,
  );
  const friendsLoaded = useSelector(selectFriendsLoaded);
  const blocksLoaded = useSelector(selectBlocksLoaded);

  useEffect(() => {
    if (!isDm || !peerUid) return;
    if (friendsEnabled && !friendsLoaded) dispatch(fetchFriends());
    if (blockEnabled && !blocksLoaded) dispatch(fetchBlocks());
  }, [isDm, peerUid, friendsEnabled, blockEnabled, friendsLoaded, blocksLoaded, dispatch]);

  const deadDm = useMemo(() => {
    if (!isDm || !peerUid) return false;
    if (blockEnabled && isBlocked) return true;
    return friendsEnabled && friendsLoaded && !isFriend;
  }, [isDm, peerUid, blockEnabled, isBlocked, friendsEnabled, friendsLoaded, isFriend]);

  return { deadDm, blockedCause: deadDm && blockEnabled && isBlocked };
}
