import { describe, expect, it } from 'vitest';
import { toMessagePreview } from '@/api/messages';
import type { ThreadListItem } from '@/api/threads';
import { createStore, type RootState } from '../index';
import { selectAllChats, selectChatUnreadCount } from '../chatsSlice';
import { messageAdded, messagePatched, messagesBulkDeleted } from '../messageEvents';
import { selectThreadSubscriptionStatus, selectThreads, setThreadsList } from '../threadsSlice';
import { insertAround, updateThreadReplyCount } from './slice';
import {
  selectActiveTimelineMessages,
  selectCanLoadNewer,
  selectPendingLiveCount,
  selectTimelineMode,
} from './selectors';
import { ids, testMessage } from './testUtils';

describe('message listener projections', () => {
  function subscribedThread(rootPatch = {}): ThreadListItem {
    const rootMessage = testMessage('10', 'client-10', {
      message: 'root body',
      hasAttachments: true,
      attachments: [
        {
          id: 'att-1',
          url: 'https://example.com/secret.png',
          kind: 'image/png',
          size: 123,
          fileName: 'secret.png',
        },
      ],
      mentions: [{ uid: 9, username: 'Mentioned', gender: 0 }],
      threadInfo: { replyCount: 1 },
      ...rootPatch,
    });

    return {
      chatId: '1',
      chatName: 'Chat',
      chatAvatar: null,
      threadRootMessage: toMessagePreview(rootMessage),
      participants: [rootMessage.sender],
      lastReply: toMessagePreview(testMessage('11', 'client-11', { replyRootId: '10' })),
      replyCount: 1,
      lastReplyAt: testMessage('11').createdAt,
      unreadCount: 0,
      lastReadMessageId: null,
      subscribedAt: rootMessage.createdAt,
      archived: false,
    };
  }

  it('projects websocket message events into the chat list while preserving historical rendering', async () => {
    const store = createStore();

    store.dispatch(
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10')],
        olderCursor: '10',
        newerCursor: '10',
      }),
    );
    store.dispatch(
      messageAdded({ chatId: '1', storeChatId: '1', message: testMessage('20'), origin: 'ws', scope: 'main' }),
    );
    await Promise.resolve();

    const root = store.getState() as RootState;
    expect(selectPendingLiveCount(root, '1')).toBe(1);
    expect(ids(selectActiveTimelineMessages(root, '1'))).toEqual(['10']);
    expect(selectAllChats(root)[0].lastMessage?.id).toBe('20');
    expect(selectChatUnreadCount(root, '1')).toBe(1);
  });

  it('keeps websocket messages visible when an around window is already at the latest edge', async () => {
    const store = createStore();

    store.dispatch(
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10'), testMessage('11')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );
    store.dispatch(
      messageAdded({ chatId: '1', storeChatId: '1', message: testMessage('12'), origin: 'ws', scope: 'main' }),
    );
    await Promise.resolve();

    const root = store.getState() as RootState;
    expect.soft(selectPendingLiveCount(root, '1')).toBe(0);
    expect.soft(ids(selectActiveTimelineMessages(root, '1'))).toEqual(['10', '11', '12']);
    expect.soft(selectTimelineMode(root, '1')).toEqual({ type: 'around', targetMessageId: '10' });
    expect.soft(selectCanLoadNewer(root, '1')).toBe(false);
    expect(selectAllChats(root)[0].lastMessage?.id).toBe('12');
    expect(selectChatUnreadCount(root, '1')).toBe(1);
  });

  it('marks a deleted thread root preview without removing the subscribed thread', async () => {
    const store = createStore();
    store.dispatch(setThreadsList({ threads: [subscribedThread()], nextCursor: null }));

    store.dispatch(
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', {
          isDeleted: true,
          message: null,
          hasAttachments: true,
          attachments: [
            {
              id: 'att-1',
              url: 'https://example.com/secret.png',
              kind: 'image/png',
              size: 123,
              fileName: 'secret.png',
            },
          ],
          mentions: [{ uid: 9, username: 'Mentioned', gender: 0 }],
        }),
      }),
    );
    await Promise.resolve();

    const root = store.getState() as RootState;
    const thread = selectThreads(root)[0];
    expect(selectThreads(root)).toHaveLength(1);
    expect(selectThreadSubscriptionStatus(root, '10')).toBe(true);
    expect(thread.threadRootMessage).toMatchObject({
      id: '10',
      isDeleted: true,
      message: null,
      sticker: null,
      attachments: [],
      mentions: [],
    });
  });

  it('marks bulk-deleted thread roots without clearing subscription state', async () => {
    const store = createStore();
    store.dispatch(setThreadsList({ threads: [subscribedThread()], nextCursor: null }));

    store.dispatch(messagesBulkDeleted({ chatId: '1', messageIds: ['10'] }));
    await Promise.resolve();

    const root = store.getState() as RootState;
    const thread = selectThreads(root)[0];
    expect(selectThreads(root)).toHaveLength(1);
    expect(selectThreadSubscriptionStatus(root, '10')).toBe(true);
    expect(thread.threadRootMessage).toMatchObject({
      id: '10',
      isDeleted: true,
      message: null,
      sticker: null,
      attachments: [],
      mentions: [],
    });
  });

  it('removes thread root placeholder when all replies are deleted and root is then deleted', async () => {
    const store = createStore();

    // Load a thread root with threadInfo
    store.dispatch(
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10', 'client-10', { threadInfo: { replyCount: 1 } }), testMessage('11')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );
    store.dispatch(setThreadsList({ threads: [subscribedThread()], nextCursor: null }));

    // Delete the root (it should stay as placeholder because threadInfo exists)
    store.dispatch(
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null, threadInfo: { replyCount: 1 } }),
      }),
    );
    await Promise.resolve();

    // Root is placeholder
    let messages = selectActiveTimelineMessages(store.getState() as RootState, '1');
    expect(ids(messages)).toContain('10');
    expect(messages.find((m) => m.id === '10')?.isDeleted).toBe(true);

    // All replies deleted → replyCount becomes 0 → threadInfo removed
    store.dispatch(updateThreadReplyCount({ chatId: '1', threadRootId: '10', replyCount: 0 }));
    await Promise.resolve();

    // Root no longer has threadInfo, but is still in timeline (isDeleted + no threadInfo)
    // Now the server sends messagePatched to fully remove it
    store.dispatch(
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null, threadInfo: null as any }),
      }),
    );
    await Promise.resolve();

    // Root should be removed from timeline
    messages = selectActiveTimelineMessages(store.getState() as RootState, '1');
    expect(ids(messages)).not.toContain('10');
  });

  it('removes thread root when threadInfo is explicitly set to null via messagePatched', async () => {
    const store = createStore();

    // Load thread root with threadInfo
    store.dispatch(
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10', 'client-10', { threadInfo: { replyCount: 3 } }), testMessage('11')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );

    // Server says threadInfo is null (thread deleted server-side)
    store.dispatch(
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null, threadInfo: null as any }),
      }),
    );
    await Promise.resolve();

    // Root removed because threadInfo is null/falsy
    const messages = selectActiveTimelineMessages(store.getState() as RootState, '1');
    expect(ids(messages)).not.toContain('10');
  });
});
