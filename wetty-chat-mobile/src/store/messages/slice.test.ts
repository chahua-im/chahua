import { describe, expect, it } from 'vitest';
import reducer, {
  applyRealtimeMessage,
  confirmOptimistic,
  insertAfterAnchor,
  insertAround,
  insertBeforeAnchor,
  markOptimisticFailed,
  mergeLatestPreserveView,
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
      refreshLatest({ chatId: '1', messages: [testMessage('2'), testMessage('1')], nextCursor: '1', prevCursor: null }),
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
        nextCursor: null,
        prevCursor: '2',
      }),
    );
    next = reducer(
      next,
      refreshLatest({ chatId: '1', messages: [testMessage('4'), testMessage('5')], nextCursor: '4', prevCursor: null }),
    );
    next = reducer(
      next,
      refreshLatest({ chatId: '1', messages: [testMessage('3'), testMessage('4')], nextCursor: '3', prevCursor: null }),
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
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-11'));
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11', 'client-11')],
        nextCursor: '10',
        prevCursor: null,
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11']);
    expect(next.chats['1'].optimisticMessages).toEqual([]);
  });

  it('merges latest without replacing the active around window for passive refreshes', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('20'), testMessage('21')],
        nextCursor: '20',
        prevCursor: null,
      }),
    );
    next = reducer(
      next,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('11')],
        nextCursor: '9',
        prevCursor: '11',
      }),
    );
    next = reducer(
      next,
      mergeLatestPreserveView({
        chatId: '1',
        messages: [testMessage('22'), testMessage('23')],
        nextCursor: '22',
        prevCursor: null,
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
    expect(segmentIds(next)).toEqual([
      ['9', '10', '11'],
      ['20', '21'],
      ['22', '23'],
    ]);
  });

  it('keeps generation stable when passive latest refresh is equivalent', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
    );
    const generation = next.chats['1'].generation;

    next = reducer(
      next,
      mergeLatestPreserveView({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
    );

    expect(next.chats['1'].generation).toBe(generation);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10']);
  });

  it('reconciles optimistic messages during passive latest refreshes', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
    );
    next = addOptimistic(next, testOptimisticMessage('client-11'));
    next = reducer(
      next,
      mergeLatestPreserveView({
        chatId: '1',
        messages: [testMessage('10'), testMessage('11', 'client-11')],
        nextCursor: '10',
        prevCursor: null,
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
        nextCursor: '20',
        prevCursor: null,
      }),
    );
    next = reducer(
      next,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('11')],
        nextCursor: '9',
        prevCursor: '11',
      }),
    );

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
    expect(segmentIds(next)).toEqual([
      ['9', '10', '11'],
      ['20', '21'],
    ]);
  });

  it('ignores around fetches that do not contain the target message', () => {
    const next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('8'), testMessage('9')],
        nextCursor: '8',
        prevCursor: '9',
      }),
    );

    expect(next.chats['1']).toBeUndefined();
  });

  it('filters before-anchor fetches to messages older than the anchor', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10'), testMessage('11')],
        nextCursor: '10',
        prevCursor: null,
      }),
    );
    next = reducer(
      next,
      insertBeforeAnchor({
        chatId: '1',
        anchorMessageId: '10',
        messages: [testMessage('9'), testMessage('10'), testMessage('12')],
        nextCursor: '9',
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
        nextCursor: '9',
        prevCursor: '10',
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('13'), testMessage('14')],
        nextCursor: '13',
        prevCursor: null,
      }),
    );
    next = reducer(
      next,
      insertAfterAnchor({
        chatId: '1',
        anchorMessageId: '10',
        messages: [testMessage('11'), testMessage('12'), testMessage('13')],
        prevCursor: null,
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
        nextCursor: '9',
        prevCursor: '11',
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('20') }));

    expect(selectPendingLiveCount(testRootState(next), '1')).toBe(1);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['9', '10', '11']);
  });

  it('applies realtime messages in sorted order when latest is active', () => {
    let next = reducer(
      undefined,
      refreshLatest({
        chatId: '1',
        messages: [testMessage('10'), testMessage('12')],
        nextCursor: '10',
        prevCursor: null,
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('11') }));

    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10', '11', '12']);
  });

  it('dedupes API confirmation and later websocket echo through production events', () => {
    let next = reducer(
      undefined,
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
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
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
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
      refreshLatest({ chatId: '1', messages: [testMessage('10')], nextCursor: '10', prevCursor: null }),
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
        nextCursor: null,
        prevCursor: null,
      }),
    );
    next = reducer(
      next,
      refreshLatest({
        chatId: '1_thread_10',
        messages: [testMessage('12', 'client-12', { replyRootId: '10', replyToMessage })],
        nextCursor: null,
        prevCursor: null,
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
});
