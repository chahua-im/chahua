import { describe, expect, it } from 'vitest';
import {
  makeServerSegment,
  normalizeAfterAnchorSegments,
  normalizeAroundSegments,
  normalizeBeforeAnchorSegments,
  normalizeLatestSegments,
} from './timelineAlgorithms';
import type { MessageSegment } from './types';
import { ids, testMessage } from './testUtils';

function segment(
  start: number,
  end: number,
  nextCursor: string | null = `${start}`,
  prevCursor: string | null = `${end}`,
): MessageSegment {
  const result = makeServerSegment(
    Array.from({ length: end - start + 1 }, (_item, index) => testMessage(String(start + index))),
    nextCursor,
    prevCursor,
  );
  if (!result) throw new Error('Expected non-empty test segment');
  return result;
}

function segmentListIds(segments: MessageSegment[]): string[][] {
  return segments.map((item) => ids(item.messages));
}

describe('timelineAlgorithms directional normalization', () => {
  it('latest insertion keeps older history and drops stale newer tail', () => {
    const result = normalizeLatestSegments([segment(1, 2), segment(7, 8)], segment(4, 5));

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['4', '5'],
    ]);
  });

  it('latest insertion replaces overlap and preserves the older prefix', () => {
    const result = normalizeLatestSegments([segment(1, 5)], segment(3, 4));

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('around insertion preserves disjoint history when it has not reached latest', () => {
    const result = normalizeAroundSegments([segment(1, 2), segment(7, 8)], segment(4, 5), {
      hasReachedLatest: false,
    });

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['4', '5'],
      ['7', '8'],
    ]);
  });

  it('around insertion uses latest-tail replacement when it reaches latest', () => {
    const result = normalizeAroundSegments([segment(1, 2), segment(7, 8)], segment(4, 5), {
      hasReachedLatest: true,
    });

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['4', '5'],
    ]);
  });

  it('before-anchor insertion replaces stale overlap and keeps the anchor-side suffix', () => {
    const result = normalizeBeforeAnchorSegments([segment(1, 5)], segment(3, 4), '5');

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['3', '4', '5'],
    ]);
  });

  it('before-anchor insertion can bridge multiple cached segments', () => {
    const result = normalizeBeforeAnchorSegments([segment(1, 3), segment(4, 6)], segment(3, 4), '5');

    expect(segmentListIds(result)).toEqual([
      ['1', '2'],
      ['3', '4', '5', '6'],
    ]);
  });

  it('after-anchor insertion replaces stale overlap and keeps the newer suffix', () => {
    const result = normalizeAfterAnchorSegments([segment(1, 5)], segment(3, 4), '2', {
      hasReachedLatest: false,
    });

    expect(segmentListIds(result)).toEqual([['1', '2', '3', '4'], ['5']]);
  });

  it('after-anchor insertion drops stale newer segments when it reaches latest', () => {
    const result = normalizeAfterAnchorSegments([segment(1, 2), segment(5, 6)], segment(3, 4), '2', {
      hasReachedLatest: true,
    });

    expect(segmentListIds(result)).toEqual([['1', '2', '3', '4']]);
  });
});
