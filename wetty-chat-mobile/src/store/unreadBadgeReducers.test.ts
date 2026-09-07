import { describe, expect, it } from 'vitest';
import type { RootState } from './index';
import chatsReducer, {
  incrementChatUnreadMentions,
  incrementChatUnreadReactions,
  setChatReadState,
  selectChatUnreadMentions,
  selectChatUnreadReactions,
  setChatUnreadMentionIds,
  setChatUnreadMentionIdsStatus,
  setChatUnreadMentions,
  setChatUnreadReactionIds,
  setChatUnreadReactionIdsStatus,
  setChatsList,
  type ChatsState,
} from './chatsSlice';
import threadsReducer, {
  incrementThreadUnreadMentions,
  incrementThreadUnreadReactions,
  setThreadReadState,
  selectThreadUnreadMentions,
  selectThreadUnreadReactions,
  setThreadsList,
} from './threadsSlice';
import type { ChatListEntry } from '@/api/chats';
import type { ThreadListItem } from '@/api/threads';

function asRootState(chats: ChatsState, threads: ReturnType<typeof threadsReducer>): RootState {
  return { chats, threads } as unknown as RootState;
}

const unreadState = (chats: ChatsState) => asRootState(chats, threadsReducer(undefined, { type: '@@init' }));

const thread: ThreadListItem = {
  chatId: 'c1',
  chatName: 'Chat',
  chatAvatar: null,
  threadRootMessage: {
    id: 't9',
    clientGeneratedId: 'cg-t9',
    createdAt: '2026-08-31T00:00:00Z',
    message: null,
    messageType: 'text',
    sender: { uid: 1, name: 'Alice', gender: 0 },
    isDeleted: false,
  },
  participants: [],
  lastReply: null,
  replyCount: 2,
  lastReplyAt: '2026-08-31T00:00:00Z',
  unreadCount: 0,
  unreadMentions: 0,
  unreadReactions: 1,
  lastReadMessageId: null,
  subscribedAt: '2026-08-31T00:00:00Z',
  archived: false,
};

function chatEntry(over: Partial<ChatListEntry> = {}): ChatListEntry {
  return {
    id: 'c1',
    name: 'Chat',
    avatar: null,
    lastMessageAt: null,
    unreadCount: 0,
    unreadMentions: 0,
    lastMessage: null,
    mutedUntil: null,
    archived: false,
    ...over,
  };
}

describe('chatsSlice unread reactions', () => {
  it('counts up per notification and prepends the id when the cache is ready', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadReactions: 1 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadReactionIdsStatus({ chatId: 'c1', status: 'loading' }));
    state = chatsReducer(state, setChatUnreadReactionIds({ chatId: 'c1', ids: ['30', '20'] }));
    state = chatsReducer(state, incrementChatUnreadReactions({ chatId: 'c1', messageId: '40' }));

    expect(selectChatUnreadReactions(unreadState(state), 'c1')).toBe(2);
    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadReactionIds).toEqual(['40', '30', '20']);
    expect(live?.unreadReactionIdsStatus).toBe('ready');
  });

  it('invalidates a mid-flight fetch when a reaction lands while loading', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadReactions: 1 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadReactionIdsStatus({ chatId: 'c1', status: 'loading' }));
    state = chatsReducer(state, incrementChatUnreadReactions({ chatId: 'c1', messageId: '40' }));

    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadReactions).toBe(2);
    // The in-flight response predates this reaction — the cache must not claim freshness.
    expect(live?.unreadReactionIdsStatus).toBe('idle');
    // Caching the pre-reaction list as 'ready' would strand that reaction: the guard no-ops.
    state = chatsReducer(state, setChatUnreadReactionIds({ chatId: 'c1', ids: ['30'] }));
    expect(state.byId['c1'].liveProjection?.unreadReactionIdsStatus).toBe('idle');
  });

  it('marks chat read: counts and caches reset to zero', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadReactions: 3 })], nextCursor: null }));
    state = chatsReducer(state, setChatReadState({ chatId: 'c1', lastReadMessageId: '40' }));

    expect(selectChatUnreadReactions(unreadState(state), 'c1')).toBe(0);
    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadReactionIds).toEqual([]);
    expect(live?.unreadReactionIdsStatus).toBe('idle');
  });

  it('reconciles the live count against a fresher server snapshot', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadReactions: 1 })], nextCursor: null }));
    state = chatsReducer(state, incrementChatUnreadReactions({ chatId: 'c1', messageId: '40' }));
    expect(state.byId['c1'].liveProjection?.unreadReactions).toBe(2);

    // Snapshot says the server has already seen the reaction — drop the live count.
    state = chatsReducer(state, setChatsList({ chats: [chatEntry({ unreadReactions: 0 })], nextCursor: null }));
    expect(state.byId['c1'].liveProjection?.unreadReactions).toBeUndefined();
    expect(selectChatUnreadReactions(unreadState(state), 'c1')).toBe(0);
  });
});

describe('threadsSlice unread reactions', () => {
  const threadsWith = (over: Partial<ReturnType<typeof threadsReducer>> = {}): ReturnType<typeof threadsReducer> => {
    const state = threadsReducer(undefined, setThreadsList({ threads: [thread], nextCursor: null }));
    return { ...state, ...over };
  };

  it('increments the count and prepends the id when the cache is ready', () => {
    let state = threadsWith({ unreadReactionIdsStatusByThread: { t9: 'ready' } });
    state = threadsReducer(state, incrementThreadUnreadReactions({ threadRootId: 't9', messageId: '40' }));

    expect(selectThreadUnreadReactions(asRootState(chatsReducer(undefined, { type: '@@init' }), state), 't9')).toBe(2);
    expect(state.unreadReactionIdsByThread['t9']).toEqual(['40']);
  });

  it('marks thread read: count and id cache reset', () => {
    let state = threadsWith({
      unreadReactionIdsStatusByThread: { t9: 'ready' },
      unreadReactionIdsByThread: { t9: ['30'] },
    });
    state = threadsReducer(state, setThreadReadState({ threadRootId: 't9' }));

    expect(selectThreadUnreadReactions(asRootState(chatsReducer(undefined, { type: '@@init' }), state), 't9')).toBe(0);
    expect(state.unreadReactionIdsByThread['t9']).toBeUndefined();
    expect(state.unreadReactionIdsStatusByThread['t9']).toBeUndefined();
  });
});

describe('chatsSlice unread mentions', () => {
  it('setChatUnreadMentions is authoritative and invalidates the id cache', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadMentions: 2 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadMentionIdsStatus({ chatId: 'c1', status: 'ready' }));
    state = chatsReducer(state, setChatUnreadMentionIds({ chatId: 'c1', ids: ['30'] }));

    state = chatsReducer(state, setChatUnreadMentions({ chatId: 'c1', unreadMentions: 5 }));

    expect(selectChatUnreadMentions(unreadState(state), 'c1')).toBe(5);
    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadMentionIds).toEqual([]);
    expect(live?.unreadMentionIdsStatus).toBe('idle');
  });

  it('increments mentions and prepends the id when the cache is ready', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadMentions: 1 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadMentionIdsStatus({ chatId: 'c1', status: 'loading' }));
    state = chatsReducer(state, setChatUnreadMentionIds({ chatId: 'c1', ids: ['30', '20'] }));
    state = chatsReducer(state, incrementChatUnreadMentions({ chatId: 'c1', messageId: '40' }));

    expect(selectChatUnreadMentions(unreadState(state), 'c1')).toBe(2);
    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadMentionIds).toEqual(['40', '30', '20']);
    expect(live?.unreadMentionIdsStatus).toBe('ready');
  });

  it('invalidates a mid-flight mention fetch and refuses to cache the stale list', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadMentions: 1 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadMentionIdsStatus({ chatId: 'c1', status: 'loading' }));
    state = chatsReducer(state, incrementChatUnreadMentions({ chatId: 'c1', messageId: '40' }));

    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadMentions).toBe(2);
    expect(live?.unreadMentionIdsStatus).toBe('idle');
    // Caching the pre-mention list as 'ready' would strand that mention: the guard no-ops.
    state = chatsReducer(state, setChatUnreadMentionIds({ chatId: 'c1', ids: ['30'] }));
    expect(state.byId['c1'].liveProjection?.unreadMentionIdsStatus).toBe('idle');
  });

  it('reconciles the live mention count against a fresher snapshot and drops the id list', () => {
    let state = chatsReducer(undefined, setChatsList({ chats: [chatEntry({ unreadMentions: 1 })], nextCursor: null }));
    state = chatsReducer(state, setChatUnreadMentionIdsStatus({ chatId: 'c1', status: 'ready' }));
    state = chatsReducer(state, setChatUnreadMentionIds({ chatId: 'c1', ids: ['30'] }));
    state = chatsReducer(state, incrementChatUnreadMentions({ chatId: 'c1', messageId: '40' }));
    expect(state.byId['c1'].liveProjection?.unreadMentions).toBe(2);

    // Snapshot says the server has already seen the mention — drop the live
    // count AND the cached id list (it was computed against the stale count).
    state = chatsReducer(state, setChatsList({ chats: [chatEntry({ unreadMentions: 0 })], nextCursor: null }));
    const live = state.byId['c1'].liveProjection;
    expect(live?.unreadMentions).toBeUndefined();
    expect(live?.unreadMentionIds).toBeUndefined();
    expect(live?.unreadMentionIdsStatus).toBe('idle');
    expect(selectChatUnreadMentions(unreadState(state), 'c1')).toBe(0);
  });
});

describe('threadsSlice unread mentions', () => {
  const threadsWithMentions = (
    over: Partial<ReturnType<typeof threadsReducer>> = {},
  ): ReturnType<typeof threadsReducer> => {
    const state = threadsReducer(undefined, setThreadsList({ threads: [thread], nextCursor: null }));
    return { ...state, ...over };
  };

  it('increments the count and prepends the id when the cache is ready', () => {
    let state = threadsWithMentions({ unreadMentionIdsStatusByThread: { t9: 'ready' } });
    state = threadsReducer(state, incrementThreadUnreadMentions({ threadRootId: 't9', messageId: '40' }));

    expect(selectThreadUnreadMentions(asRootState(chatsReducer(undefined, { type: '@@init' }), state), 't9')).toBe(1);
    expect(state.unreadMentionIdsByThread['t9']).toEqual(['40']);
  });

  it('marks thread read: mention count and id cache reset', () => {
    let state = threadsWithMentions({
      unreadMentionIdsStatusByThread: { t9: 'ready' },
      unreadMentionIdsByThread: { t9: ['30'] },
    });
    state = threadsReducer(state, setThreadReadState({ threadRootId: 't9' }));

    expect(selectThreadUnreadMentions(asRootState(chatsReducer(undefined, { type: '@@init' }), state), 't9')).toBe(0);
    expect(state.unreadMentionIdsByThread['t9']).toBeUndefined();
    expect(state.unreadMentionIdsStatusByThread['t9']).toBeUndefined();
  });
});
