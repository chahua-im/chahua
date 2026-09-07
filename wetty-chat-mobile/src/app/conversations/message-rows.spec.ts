import { encodeId } from '../api/snowflake-id';
import { testMessage } from '../api/testing';
import { messageRows } from './message-rows';
import { MessageType } from '../../generated/models';

describe('messageRows', () => {
  it('handles empty and single-message ranges', () => {
    expect(messageRows([])).toEqual([]);
    expect(messageRows([testMessage])).toEqual([{ message: testMessage, first: true, last: true, dateBreak: true }]);
  });

  it('groups adjacent messages by sender and local day regardless of time gap', () => {
    const messages = [
      { ...testMessage, id: encodeId('100'), createdAt: new Date(2026, 8, 5, 1).toISOString() },
      { ...testMessage, id: encodeId('101'), createdAt: new Date(2026, 8, 5, 23).toISOString() },
      { ...testMessage, id: encodeId('102'), createdAt: new Date(2026, 8, 6, 0).toISOString() },
      {
        ...testMessage,
        id: encodeId('103'),
        createdAt: new Date(2026, 8, 6, 1).toISOString(),
        sender: { uid: 2, name: '小花', gender: 0 },
      },
    ];
    expect(messageRows(messages).map(({ first, last, dateBreak }) => ({ first, last, dateBreak }))).toEqual([
      { first: true, last: false, dateBreak: true },
      { first: false, last: true, dateBreak: false },
      { first: true, last: true, dateBreak: true },
      { first: true, last: true, dateBreak: false },
    ]);
  });

  it('keeps system messages separate and recomputes edges as the range grows', () => {
    const older = { ...testMessage, id: encodeId('99') };
    const newer = { ...testMessage, id: encodeId('101') };
    expect(messageRows([older, testMessage, newer]).map(({ first, last }) => ({ first, last }))).toEqual([
      { first: true, last: false },
      { first: false, last: false },
      { first: false, last: true },
    ]);
    const rows = messageRows([older, { ...testMessage, messageType: MessageType.system }, newer]);
    expect(rows.every((row) => row.first && row.last)).toBe(true);
    expect(rows.map((row) => row.dateBreak)).toEqual([true, false, false]);
    expect(rows.map((row) => row.message.id)).toEqual([encodeId('99'), testMessage.id, encodeId('101')]);
  });
});
