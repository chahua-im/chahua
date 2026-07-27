import { useEffect } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import { t } from '@lingui/core/macro';
import { getChatUnreadCount } from '@/api/chats';
import { getGroupInfo, type GroupRole } from '@/api/group';
import type { GroupKind } from '@/api/dms';
import type { MemberSummary } from '@/api/users';
import type { ChatMeta } from '@/store/chatsSlice';
import {
  selectChatLastReadMessageId,
  selectChatMeta,
  selectChatUnreadCount,
  selectIsChatMuted,
  setChatLastReadMessageId,
  setChatMeta,
  setChatMutedUntil,
  setChatUnreadCount,
} from '@/store/chatsSlice';
import type { RootState } from '@/store/index';
import { hasLoadedThreadChatMeta } from '../utils/conversationUtils';

interface UseChatMetadataArgs {
  chatId: string;
  threadId?: string;
}

interface ChatStoreSnapshot {
  meta: ChatMeta | undefined;
  isMuted: boolean;
  lastReadMessageId: string | null;
  unreadCount: number;
}

function selectChatStoreSnapshot(state: RootState, chatId: string): ChatStoreSnapshot {
  return {
    meta: selectChatMeta(state, chatId),
    isMuted: selectIsChatMuted(state, chatId),
    lastReadMessageId: selectChatLastReadMessageId(state, chatId),
    unreadCount: selectChatUnreadCount(state, chatId),
  };
}

export interface UseChatMetadataResult {
  meta: ChatMeta | undefined;
  name: string | null;
  role: GroupRole | null;
  isAdmin: boolean;
  isMuted: boolean;
  lastReadMessageId: string | null;
  unreadCount: number;
  metaLoading: boolean;
  kind: GroupKind | undefined;
  isDm: boolean;
  peer: MemberSummary | null;
}

export function useChatMetadata({ chatId, threadId }: UseChatMetadataArgs): UseChatMetadataResult {
  const dispatch = useDispatch();
  const { meta, isMuted, lastReadMessageId, unreadCount } = useSelector(
    (state: RootState) => selectChatStoreSnapshot(state, chatId),
    shallowEqual,
  );

  const role = meta?.myRole ?? null;
  const kind = meta?.kind;
  const peer = meta?.peer ?? null;
  const isDm = kind === 'dm';
  // DMs are named after the peer; normal chats use the group name.
  const name = isDm ? (peer?.username ?? (peer ? t`User ${peer.uid}` : null)) : (meta?.name ?? null);
  const metaLoaded = hasLoadedThreadChatMeta(meta);
  const metaLoading = !metaLoaded;

  useEffect(() => {
    if (threadId || metaLoaded) return;

    getGroupInfo(chatId)
      .then((res) => {
        const { id, mutedUntil, ...groupMeta } = res.data;
        void id;
        dispatch(setChatMeta({ chatId, meta: groupMeta }));
        dispatch(setChatMutedUntil({ chatId, mutedUntil: mutedUntil ?? null }));
      })
      .catch(() => {});
  }, [chatId, dispatch, metaLoaded, threadId]);

  useEffect(() => {
    if (threadId) return;

    let canceled = false;
    getChatUnreadCount(chatId)
      .then((res) => {
        if (canceled) return;
        dispatch(setChatLastReadMessageId({ chatId, lastReadMessageId: res.data.lastReadMessageId }));
        dispatch(setChatUnreadCount({ chatId, unreadCount: res.data.unreadCount }));
      })
      .catch(() => {});

    return () => {
      canceled = true;
    };
  }, [chatId, dispatch, threadId]);

  return {
    meta,
    name,
    role,
    isAdmin: role === 'admin',
    isMuted,
    lastReadMessageId,
    unreadCount: threadId ? 0 : unreadCount,
    metaLoading,
    kind,
    isDm,
    peer,
  };
}
