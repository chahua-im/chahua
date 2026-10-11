import { describe, expect, it } from 'vitest';
import {
  capRange,
  classifyKeyMutation,
  computeAlignedScrollTarget,
  detectAlternatingJitter,
  normalizeRange,
  unionRanges,
  visiblePrefixHeight,
} from './layoutMath';

describe('virtual scroll layout math', () => {
  it('classifies message-key mutations while ignoring date rows', () => {
    expect(classifyKeyMutation(['date:a', 'grp:1', 'grp:2'], ['date:a', 'grp:1', 'grp:2'])).toBe('none');
    expect(classifyKeyMutation(['grp:3', 'grp:4'], ['grp:1', 'grp:2', 'grp:3', 'grp:4'])).toBe('prepend');
    expect(classifyKeyMutation(['grp:1', 'grp:2'], ['grp:1', 'grp:2', 'date:b', 'grp:3'])).toBe('append');
    expect(classifyKeyMutation(['grp:1', 'grp:3'], ['grp:1', 'grp:2', 'grp:3'])).toBe('reset');
    // Prepend-merge: older same-sender messages merge into the old first
    // group, changing its key (derived from the first message id). Must still
    // classify as prepend, not reset, so the prepend compensation keeps the
    // scroll position instead of re-bootstrapping to the latest message.
    expect(classifyKeyMutation(['grp:1', 'grp:2', 'grp:3'], ['grp:0', 'grp:1m', 'grp:2', 'grp:3'])).toBe('prepend');
  });

  it('normalizes, unions, and caps mounted ranges', () => {
    expect(normalizeRange(8, 2, 10)).toEqual({ start: 2, end: 8 });
    expect(normalizeRange(8, 2, -1)).toBeNull();
    expect(unionRanges({ start: 4, end: 8 }, { start: 1, end: 5 })).toEqual({ start: 1, end: 8 });
    expect(capRange({ start: 0, end: 120 }, 150)).toEqual({ start: 12, end: 107 });
  });

  it('computes visible prefixes and alternating one-pixel jitter', () => {
    expect(visiblePrefixHeight(100, 50, 125)).toBe(25);
    expect(visiblePrefixHeight(100, 50, 200)).toBe(50);
    expect(
      detectAlternatingJitter([
        { top: 10, at: 0 },
        { top: 11, at: 10 },
        { top: 10, at: 20 },
        { top: 11, at: 30 },
        { top: 10, at: 40 },
        { top: 11, at: 50 },
      ]),
    ).toEqual({ values: [10, 11], durationMs: 50 });
  });
});

describe('computeAlignedScrollTarget', () => {
  // 600px viewport in a 2000px document -> maxScroll = 1400.
  const clientHeight = 600;
  const scrollHeight = 2000;

  it('aligns a row to the viewport top and clamps into the scroll range', () => {
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'top', 0.5)).toBe(900);
    // Negative and past-the-end rows clamp to [0, maxScroll].
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, -40, 80, 'top', 0.5)).toBe(0);
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 1900, 80, 'top', 0.5)).toBe(1400);
  });

  it('bottom-aligns using the row height and viewport height', () => {
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'bottom', 0.5)).toBe(380);
    // A row whose bottom sits at 1980 scrolls to 1380 (< maxScroll 1400, no clamp).
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 1900, 80, 'bottom', 0.5)).toBe(1380);
  });

  it('positions a row at offsetRatio and clamps the ratio to [0, 1]', () => {
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'custom', 0.5)).toBe(600);
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'custom', 0)).toBe(900);
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'custom', 1)).toBe(300);
    // Out-of-range ratios clamp before use.
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'custom', 5)).toBe(300);
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900, 80, 'custom', -2)).toBe(900);
  });

  it('rounds fractional offsets so scroll comparisons stay pixel-stable', () => {
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900.4, 80, 'top', 0.5)).toBe(900);
    expect(computeAlignedScrollTarget(clientHeight, scrollHeight, 900.6, 80, 'top', 0.5)).toBe(901);
  });

  it('clamps to zero when the content is shorter than the viewport', () => {
    expect(computeAlignedScrollTarget(600, 500, 300, 80, 'top', 0.5)).toBe(0);
  });
});
