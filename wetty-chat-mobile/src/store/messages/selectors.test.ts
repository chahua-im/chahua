import { describe, expect, it } from 'vitest';
import reducer, {
  applyRealtimeMessage,
  clearPendingLiveMessages,
  insertAround,
  refreshLatest,
  setTimelineMode,
} from './slice';
import {
  selectActiveTimelineMessages,
  selectAllTimelineMessages,
  selectCanLoadNewer,
  selectCanLoadOlder,
  selectHasLoadedTimeline,
  selectLatestServerMessage,
  selectLatestThreadReplyMessage,
  selectNewerAnchor,
  selectOlderAnchor,
  selectPendingLiveCount,
} from './selectors';
import { ids, testMessage, testRootState } from './testUtils';

describe('message timeline selectors', () => {
  it('selects active around/latest messages, anchors, loadability, and latest message', () => {
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
        messages: [testMessage('10')],
        nextCursor: 'older-cursor',
        prevCursor: 'newer-cursor',
      }),
    );

    expect(selectHasLoadedTimeline(testRootState(next), '1')).toBe(true);
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['10']);
    expect(selectCanLoadOlder(testRootState(next), '1')).toBe(true);
    expect(selectCanLoadNewer(testRootState(next), '1')).toBe(true);
    expect(selectOlderAnchor(testRootState(next), '1')).toBe('older-cursor');
    expect(selectNewerAnchor(testRootState(next), '1')).toBe('newer-cursor');
    expect(selectLatestServerMessage(testRootState(next), '1')?.id).toBe('21');

    next = reducer(next, setTimelineMode({ chatId: '1', mode: { type: 'latest' } }));
    expect(ids(selectActiveTimelineMessages(testRootState(next), '1'))).toEqual(['20', '21']);
  });

  it('selects all loaded timeline messages and latest thread reply', () => {
    const next = reducer(
      undefined,
      refreshLatest({
        chatId: '1_thread_10',
        messages: [
          testMessage('12', 'client-12', { replyRootId: '10' }),
          testMessage('11', 'client-11', { replyRootId: '10' }),
        ],
        nextCursor: null,
        prevCursor: null,
      }),
    );

    expect(ids(selectAllTimelineMessages(testRootState(next), '1_thread_10'))).toEqual(['11', '12']);
    expect(selectLatestThreadReplyMessage(testRootState(next), '1', '10')?.id).toBe('12');
  });

  it('clears pending live state when switching to latest or explicitly clearing', () => {
    let next = reducer(
      undefined,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10')],
        nextCursor: '10',
        prevCursor: '10',
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('20') }));
    next = reducer(next, setTimelineMode({ chatId: '1', mode: { type: 'latest' } }));
    expect(selectPendingLiveCount(testRootState(next), '1')).toBe(0);

    next = reducer(
      next,
      insertAround({
        chatId: '1',
        targetMessageId: '10',
        messages: [testMessage('10')],
        nextCursor: '10',
        prevCursor: '10',
      }),
    );
    next = reducer(next, applyRealtimeMessage({ chatId: '1', message: testMessage('21') }));
    next = reducer(next, clearPendingLiveMessages({ chatId: '1' }));
    expect(selectPendingLiveCount(testRootState(next), '1')).toBe(0);
  });
});
