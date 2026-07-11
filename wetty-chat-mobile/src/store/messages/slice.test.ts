import { describe, expect, it } from 'vitest';
import reducer, {
  applyRealtimeMessage,
  confirmOptimistic,
  insertAfterAnchor,
  insertAround,
  insertBeforeAnchor,
  markOptimisticFailed,
  refreshLatest,
} from './slice';
import { selectActiveTimelineMessages, selectCanLoadNewer, selectPendingLiveCount } from './selectors';
import {
  messageAdded,
  messageConfirmed,
  messagePatched,
  messagesBulkDeleted,
  reactionsUpdated,
} from '../messageEvents';
import type { MessageResponse } from '@/api/messages';
import type { MessagesState } from './types';
import { ids, segmentIds, testMessage, testOptimisticMessage, testRootState } from './testUtils';

function addOptimistic(state: MessagesState, optimistic = testOptimisticMessage()): MessagesState {
  return reducer(
    state,
    messageAdded({ chatId: '1', storeChatId: '1', message: optimistic, origin: 'optimistic', scope: 'main' }),
  );
}

describe('messages slice canonical reducers', () => {
  it('refreshes latest into an empty timeline', () => {
    const next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('2'), testMessage('1')],
        olderCursor: '1',
        newerCursor: null,
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['1', '2']);
    expect(next.chats['1'].hasReachedLatest).toBe(true);
    expect(next.chats['1'].hasReachedOldest).toBe(false);
  });

  it('refreshes latest with latest-tail replacement semantics', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '2',
        messages: [testMessage('1'), testMessage('2')],
        olderCursor: null,
        newerCursor: '2',
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('4'), testMessage('5')],
        olderCursor: '4',
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('3'), testMessage('4')],
        olderCursor: '3',
        newerCursor: null,
      }),
    );

    expect(segmentIds(next)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['3', '4']);
  });

  it('preserves and reconciles optimistic messages across latest refreshes', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], olderCursor: '10', newerCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-11'));
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11', 'client-11')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11']);
    expect(next.chats['1'].optimisticMessages).toEqual([]);
  });

  it('inserts around historical messages without disturbing latest', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('20'), testMessage('21')],
        olderCursor: '20',
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('11')],
        olderCursor: '9',
        newerCursor: '11',
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
    expect(segmentIds(next)).toEqual([
      ['9', '10', '11'],
      ['20', '21'],
    ]);
  });

  it('retains non-empty around fetches that do not contain the target message', () => {
    const next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('8'), testMessage('9')],
        olderCursor: '8',
        newerCursor: '9',
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['8', '9']);
    expect(segmentIds(next)).toEqual([['8', '9']]);
  });

  it('filters before-anchor fetches to messages older than the anchor', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10'), testMessage('11')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      insertBeforeAnchor({
        chatId: '1',
        anchorMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('12')],
        olderCursor: '9',
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
  });

  it('merges newer history into latest when the fetched range closes the gap', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('9'), testMessage('10')],
        olderCursor: '9',
        newerCursor: '10',
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('13'), testMessage('14')],
        olderCursor: '13',
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      insertAfterAnchor({
        chatId: '1',
        anchorMessageId: '10',
        messages: [testMessage('11'), testMessage('12'), testMessage('13')],
        newerCursor: null,
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11', '12', '13']);
    expect(segmentIds(next)).toEqual([['9', '10', '11', '12', '13']]);
    expect(selectCanLoadNewer(testRootState(next), '1')).toBe(false);
  });

  it('tracks pending live messages while browsing history', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('11')],
        olderCursor: '9',
        newerCursor: '11',
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('20') }));

    expect(selectPendingLiveCount(testRootState(next), '1')).toBe(1);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
  });

  it('treats missing-target around windows at the latest edge as realtime-visible', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('8'), testMessage('9')],
        olderCursor: '8',
        newerCursor: null,
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('11') }));

    expect(selectPendingLiveCount(testRootState(next), '1')).toBe(0);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['8', '9', '11']);
  });

  it('applies realtime messages in sorted order when latest is active', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('12')],
        olderCursor: '10',
        newerCursor: null,
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('11') }));

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11', '12']);
  });

  it('dedupes API confirmation and later websocket echo through production events', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], olderCursor: '10', newerCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-11'));
    next = reducer(
      next,
      messageConfirmed({
        chatId: '1',
        storeChatId: '1',
        clientGeneratedId: 'client-11',
        message: testMessage('11', 'client-11'),
        origin: 'api_confirm',
        scope: 'main',
      }),
    );
    next = reducer(
      next,
      messageAdded({
        chatId: '1',
        storeChatId: '1',
        message: testMessage('11', 'client-11'),
        origin: 'ws',
        scope: 'main',
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11']);
  });

  it('confirms optimistic messages through the public reducer action', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], olderCursor: '10', newerCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-11'));
    next = reducer(
      next,
      confirmOptimistic({ chatId: '1', clientGeneratedId: 'client-11', message: testMessage('11', 'client-11') }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11']);
    expect(next.chats['1'].optimisticMessages).toEqual([]);
  });

  it('marks optimistic messages as failed with the current fallback representation', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], olderCursor: '10', newerCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-failed'));
    next = reducer(next, markOptimisticFailed({ chatId: '1', clientGeneratedId: 'client-failed' }));

    expect(next.chats['1'].optimisticMessages[0].isDeleted).toBe(true);
  });

  it('patches, deletes, bulk deletes, and reacts across loaded main/thread segments', () => {
    const replyToMessage: MessageResponse['replyToMessage'] = {
      id: '10',
      clientGeneratedId: 'client-10',
      createdAt: testMessage('10').createdAt,
      message: 'message 10',
      messageType: 'text',
      sender: { uid: 2, name: 'User', gender: 0 },
      isDeleted: false,
    };
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11')],
        olderCursor: null,
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1_thread_10',
        messages: [testMessage('12', 'client-12', { replyRootId: '10', replyToMessage })],
        olderCursor: null,
        newerCursor: null,
      }),
    );
    next = reducer(
      next,
      messagePatched({ chatId: '1', messageId: '10', message: { ...testMessage('10'), message: 'edited' } }),
    );
    next = reducer(
      next,
      reactionsUpdated({
        chatId: '1',
        messageId: '11',
        reactions: [{ emoji: 'thumbs-up', count: 1, reactedByMe: true }],
      }),
    );
    next = reducer(next, messagesBulkDeleted({ chatId: '1', messageIds: ['10'] }));

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['11']);
    expect(selectActiveTimelineMessages(testRootState(next), '1')[0].reactions?.[0]?.emoji).toBe('thumbs-up');
    expect(selectActiveTimelineMessages(testRootState(next), '1_thread_10')[0].replyToMessage?.isDeleted).toBe(true);
  });

  it('updates replyToMessage.isDeleted when the referenced message is deleted via messagePatched', () => {
    const replyToMessage: MessageResponse['replyToMessage'] = {
      id: '10',
      clientGeneratedId: 'client-10',
      createdAt: testMessage('10').createdAt,
      message: 'message 10',
      messageType: 'text',
      sender: { uid: 2, name: 'User', gender: 0 },
      isDeleted: false,
    };
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11', 'client-11', { replyToMessage })],
        olderCursor: null,
        newerCursor: null,
      }),
    );

    // Delete msg10 via messagePatched (single delete path)
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null }),
      }),
    );

    // msg10 removed from timeline
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['11']);
    // msg11's replyToMessage.isDeleted updated to true
    expect(selectActiveTimelineMessages(testRootState(next), '1')[0].replyToMessage?.isDeleted).toBe(true);
    expect(selectActiveTimelineMessages(testRootState(next), '1')[0].replyToMessage?.message).toBeNull();
  });

  it('keeps thread root as placeholder when deleted but threadInfo exists', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10', 'client-10', { threadInfo: { replyCount: 3 } }), testMessage('11')],
        olderCursor: null,
        newerCursor: null,
      }),
    );

    // Delete thread root via messagePatched
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null, threadInfo: { replyCount: 3 } }),
      }),
    );

    // Thread root stays as placeholder (has threadInfo)
    const messages = selectActiveTimelineMessages(testRootState(next), '1');
    expect(ids(messages)).toEqual(['10', '11']);
    expect(messages[0].isDeleted).toBe(true);
    expect(messages[0].message).toBeNull();
    expect(messages[0].threadInfo).toEqual({ replyCount: 3 });
  });

  it('removes thread root when deleted and threadInfo is null', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10', 'client-10', { threadInfo: { replyCount: 3 } }), testMessage('11')],
        olderCursor: null,
        newerCursor: null,
      }),
    );

    // Delete thread root with threadInfo explicitly set to null (server says no thread)
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null, threadInfo: null as any }),
      }),
    );

    // Thread root removed (threadInfo is null/falsy)
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['11']);
  });

  it('removes thread root when deleted and no threadInfo on existing message', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11')],
        olderCursor: null,
        newerCursor: null,
      }),
    );

    // Delete a regular message (no threadInfo)
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null }),
      }),
    );

    // Message removed from timeline
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['11']);
  });

  it('cleans up empty segments after deletion', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10')],
        olderCursor: '10',
        newerCursor: '10',
      }),
    );

    // Delete the only message in the segment
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '10',
        message: testMessage('10', 'client-10', { isDeleted: true, message: null }),
      }),
    );

    // Segment should be cleaned up
    expect(next.chats['1'].segments).toHaveLength(0);
  });

  it('preserves forwardedFrom when message is added via messageAdded', () => {
    const forwardedMessage = testMessage('20', 'client-20', {
      forwardedFrom: {
        sender: { uid: 99, name: 'OriginalSender', gender: 0 },
        originalChatId: 'other-chat',
        originalMessageId: 'orig-1',
      },
    });

    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], olderCursor: '10', newerCursor: null }),
    );
    next = reducer(
      next,
      messageAdded({ chatId: '1', storeChatId: '1', message: forwardedMessage, origin: 'ws', scope: 'main' }),
    );

    const messages = selectActiveTimelineMessages(testRootState(next), '1');
    const fwd = messages.find((m) => m.id === '20');
    expect(fwd?.forwardedFrom).toBeDefined();
    expect(fwd?.forwardedFrom?.sender.name).toBe('OriginalSender');
    expect(fwd?.forwardedFrom?.originalChatId).toBe('other-chat');
  });

  it('preserves forwardedFrom when message is loaded via refreshLatest', () => {
    const forwardedMessage = testMessage('20', 'client-20', {
      forwardedFrom: {
        sender: { uid: 99, name: 'OriginalSender', gender: 0 },
        originalChatId: 'other-chat',
        originalMessageId: 'orig-1',
      },
    });

    const next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [forwardedMessage], olderCursor: null, newerCursor: null }),
    );

    const messages = selectActiveTimelineMessages(testRootState(next), '1');
    expect(messages[0].forwardedFrom).toBeDefined();
    expect(messages[0].forwardedFrom?.sender.name).toBe('OriginalSender');
    expect(messages[0].forwardedFrom?.originalChatId).toBe('other-chat');
  });

  it('preserves reactions and replyTo when a non-delete patch omits them', () => {
    const base = testMessage('30', 'client-30', {
      reactions: [{ emoji: '👍', count: 1, users: [{ uid: 1 }] }] as any,
      replyToMessage: {
        id: '10',
        senderName: 'A',
        message: 'hi',
        messageType: 'text',
        isDeleted: false,
      } as any,
    });
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [base], olderCursor: null, newerCursor: null }),
    );
    // Patch carries only id + body; reactions/replyToMessage are absent (undefined),
    // so the `??` fallbacks must restore the originals (regression guard for M7).
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '30',
        message: { id: '30', message: 'edited', messageType: 'text' } as any,
      }),
    );
    const msg = selectActiveTimelineMessages(testRootState(next), '1').find((m) => m.id === '30')!;
    expect(msg.message).toBe('edited');
    expect(msg.reactions).toHaveLength(1);
    expect(msg.replyToMessage?.id).toBe('10');
  });

  it('preserves forwardedFrom when a forwarded message is patched (edit)', () => {
    const forwarded = testMessage('40', 'client-40', {
      forwardedFrom: {
        sender: { uid: 99, name: 'OriginalSender', gender: 0 },
        originalChatId: 'other-chat',
        originalMessageId: 'orig-1',
      },
    });
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [forwarded], olderCursor: null, newerCursor: null }),
    );
    // Edit the forwarded message body; forwardedFrom must survive because the patch omits it.
    next = reducer(
      next,
      messagePatched({
        chatId: '1',
        messageId: '40',
        message: { id: '40', message: 'edited forward', messageType: 'text' } as any,
      }),
    );
    const msg = selectActiveTimelineMessages(testRootState(next), '1').find((m) => m.id === '40')!;
    expect(msg.message).toBe('edited forward');
    expect(msg.forwardedFrom).toBeDefined();
    expect(msg.forwardedFrom?.sender.name).toBe('OriginalSender');
  });
});
