import { encodeId } from '../../api/snowflake-id';
import { testMessage } from '../../api/testing';
import { PageDirection } from '../conversation-store';
import { findSelectionInterval, selectionDirectionAfterScroll } from './selection-range';

describe('selection range', () => {
  const { Older, Newer } = PageDirection;
  const [before, first, anchor, last, after] = ['99', '100', '101', '102', '103'].map(encodeId);
  const page = { messages: [first, anchor, last].map((id) => ({ ...testMessage, id })) };
  const indices = new Map([before, first, anchor, last, after].map((id, index) => [id, index]));

  it('includes the visible endpoint and excludes the selected anchor in either direction', () => {
    expect(findSelectionInterval(Older, anchor, first, page, () => indices)).toEqual({ start: 1, end: 2 });
    expect(findSelectionInterval(Newer, anchor, last, page, () => indices)).toEqual({ start: 3, end: 4 });
    expect(findSelectionInterval(Newer, anchor, anchor, page, () => indices)).toBeUndefined();
  });

  it('excludes acknowledged outbox endpoints across either gap in loaded history', () => {
    expect(
      findSelectionInterval(Older, anchor, before, { ...page, olderCursor: first }, () => indices),
    ).toBeUndefined();
    expect(findSelectionInterval(Newer, anchor, after, { ...page, newerCursor: last }, () => indices)).toBeUndefined();
    expect(findSelectionInterval(Newer, anchor, after, page, () => indices)).toEqual({ start: 3, end: 5 });
  });

  it('keeps the current offer if the other direction reaches the edge without a valid range', () => {
    const edges = { [Older]: first, [Newer]: last };
    const canExtend = (direction: PageDirection) => direction === Older;
    expect(selectionDirectionAfterScroll(Older, Newer, edges, edges, true, canExtend)).toBe(Older);
  });
});
