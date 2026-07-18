import type { MountedWindow, MutationType } from './types';
import { WINDOW_CAP } from './types';

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((value, index) => full[index] === value);
}

function commonSuffixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let len = 0;
  while (len < max && a[a.length - 1 - len] === b[b.length - 1 - len]) {
    len += 1;
  }
  return len;
}

function isSubsequence(sub: string[], full: string[]): boolean {
  let i = 0;
  for (let j = 0; j < full.length && i < sub.length; j++) {
    if (sub[i] === full[j]) i++;
  }
  return i === sub.length;
}

export function classifyKeyMutation(prev: string[], next: string[]): MutationType {
  const prevMsgs = prev.filter((key) => key.startsWith('grp:'));
  const nextMsgs = next.filter((key) => key.startsWith('grp:'));

  if (arraysEqual(prevMsgs, nextMsgs)) return 'none';
  if (prevMsgs.length === 0 || nextMsgs.length === 0) return 'reset';
  if (nextMsgs.length < prevMsgs.length && isSubsequence(nextMsgs, prevMsgs)) return 'delete';
  if (nextMsgs.length < prevMsgs.length) return 'reset';
  // Prepend: older messages added at the front. Normally prev is an exact suffix
  // of next. But when prepended messages merge into the old first group (same
  // sender + same date), that group's key changes (it derives from the first
  // message id), so prev is no longer an exact suffix. Detect this by allowing
  // only the leading group to differ — and only when its old key truly
  // disappeared from next (merged away, not merely repositioned by a middle
  // insert). Otherwise a middle insert would be misread as a prepend.
  const commonSuffix = commonSuffixLength(prevMsgs, nextMsgs);
  if (nextMsgs.length > prevMsgs.length) {
    if (commonSuffix >= prevMsgs.length) {
      return 'prepend';
    }
    if (prevMsgs.length >= 2 && commonSuffix === prevMsgs.length - 1 && !nextMsgs.includes(prevMsgs[0])) {
      return 'prepend';
    }
  }
  if (isPrefix(prevMsgs, nextMsgs)) return 'append';
  return 'reset';
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundScrollValue(value: number): number {
  return Math.round(value);
}

export function hasMeaningfulScrollDelta(current: number, next: number): boolean {
  return Math.abs(next - current) >= 1;
}

export function scrollDirection(from: number, to: number): 'up' | 'down' | 'none' {
  if (to > from) return 'down';
  if (to < from) return 'up';
  return 'none';
}

export function detectAlternatingJitter(samples: Array<{ top: number; at: number }>) {
  if (samples.length < 6) return null;
  const tops = samples.map((sample) => sample.top);
  const unique = [...new Set(tops)];
  if (unique.length !== 2) return null;

  const [a, b] = unique;
  if (Math.abs(a - b) > 1) return null;

  for (let index = 2; index < tops.length; index += 1) {
    if (tops[index] !== tops[index - 2]) return null;
  }

  return {
    values: unique.sort((left, right) => left - right),
    durationMs: samples[samples.length - 1].at - samples[0].at,
  };
}

export function normalizeRange(start: number, end: number, maxIndex: number): MountedWindow | null {
  if (maxIndex < 0) return null;
  const nextStart = clamp(Math.min(start, end), 0, maxIndex);
  const nextEnd = clamp(Math.max(start, end), 0, maxIndex);
  return nextStart <= nextEnd ? { start: nextStart, end: nextEnd } : null;
}

export function rangesEqual(left: MountedWindow | null, right: MountedWindow | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.start === right.start && left.end === right.end;
}

export function unionRanges(left: MountedWindow | null, right: MountedWindow | null): MountedWindow | null {
  if (!left) return right;
  if (!right) return left;
  return { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) };
}

export function capRange(range: MountedWindow, maxIndex: number): MountedWindow {
  const size = range.end - range.start + 1;
  if (size <= WINDOW_CAP || maxIndex < 0) return range;

  const center = Math.floor((range.start + range.end) / 2);
  const halfCap = Math.floor(WINDOW_CAP / 2);
  const maxStart = Math.max(0, maxIndex - WINDOW_CAP + 1);
  const start = clamp(center - halfCap, 0, maxStart);
  return { start, end: Math.min(maxIndex, start + WINDOW_CAP - 1) };
}

export function visiblePrefixHeight(rowTop: number, rowHeight: number, viewportTop: number): number {
  return clamp(viewportTop - rowTop, 0, Math.max(0, rowHeight));
}

export function rangeSize(range: MountedWindow | null): number {
  if (!range) return 0;
  return range.end - range.start + 1;
}
