/**
 * Whitespace reflow before Markdown parsing.
 *
 * CommonMark makes `** bold **` render literally, so formatting a selection
 * that already included spaces (`  hello  `) would leave the result unstyled.
 * This module moves those redundant spaces OUTSIDE the paired markers so the
 * content renders while ordinary text stays untouched:
 *
 *     `a** b **c`       →  `a **b** c`
 *     `** @[uid:1] **`  →  ` **@[uid:1]** `
 *
 * Two-character runs (`**`/`~~`/`__`) forgive spaces on either inner side;
 * single stars stay literal. Code spans, fences, escaped characters and
 * multi-line content are skipped.
 */

import { findCodeRegions } from './code-regions';

/** Code and escaped characters must remain verbatim during normalization. */
function maskCodeRegions(src: string): boolean[] {
  const masked = new Array<boolean>(src.length).fill(false);
  for (const { start, end } of findCodeRegions(src)) masked.fill(true, start, end);
  for (let i = 0; i < src.length - 1; i++) {
    if (!masked[i] && src[i] === '\\') {
      masked[i] = masked[i + 1] = true;
      i++;
    }
  }
  return masked;
}

interface MarkerRun {
  start: number;
  ch: string;
}

function collectPairs(src: string, masked: boolean[]): Array<[number, number]> {
  const n = src.length;
  const runs: MarkerRun[] = [];
  let i = 0;
  while (i < n) {
    if (masked[i] || (src[i] !== '*' && src[i] !== '~' && src[i] !== '_')) {
      i++;
      continue;
    }
    const ch = src[i];
    let j = i;
    while (j < n && src[j] === ch) j++;
    const len = j - i;
    if (len === 2) {
      runs.push({ start: i, ch });
    }
    i = j;
  }

  const pairs: Array<[number, number]> = [];
  const open: MarkerRun[] = [];
  let previous = 0;
  for (const run of runs) {
    if (/[\r\n]/.test(src.slice(previous, run.start))) open.length = 0;
    previous = run.start;
    const index = open.findIndex((candidate) => candidate.ch === run.ch);
    if (index === -1) {
      open.push(run);
    } else {
      pairs.push([open[index].start, run.start]);
      open.splice(index);
    }
  }
  // Reflow inner pairs before outer pairs; every replacement preserves length.
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs;
}

/**
 * Moves redundant spaces directly inside a paired marker to its outside.
 * Only exact `**`/`~~`/`__` pairs participate.
 */
function reflowPairedSpaces(src: string): string {
  if (!src) return src;
  const masked = maskCodeRegions(src);
  const pairs = collectPairs(src, masked);
  const markerLen = 2;

  let out = src;
  for (let p = pairs.length - 1; p >= 0; p--) {
    const [openStart, closeStart] = pairs[p];
    if (closeStart <= openStart + markerLen) continue; // adjacent markers, no content

    const mid = out.slice(openStart + markerLen, closeStart);
    if (mid.includes('\n')) continue; // never reflow across line breaks

    let lead = 0;
    while (lead < mid.length && (mid[lead] === ' ' || mid[lead] === '\t')) lead++;
    let trail = 0;
    while (trail < mid.length - lead && (mid[mid.length - 1 - trail] === ' ' || mid[mid.length - 1 - trail] === '\t')) {
      trail++;
    }
    const inner = mid.slice(lead, mid.length - trail);
    if (inner.length <= 0) continue; // whitespace-only pair
    if (lead === 0 && trail === 0) continue; // nothing to move

    // Preserve the existing numeric and identifier boundary rules.
    const prevChar = openStart > 0 ? out[openStart - 1] : '';
    const nextChar = closeStart + markerLen < out.length ? out[closeStart + markerLen] : '';
    if (/[0-9]/.test(prevChar) || /[0-9]/.test(nextChar)) continue;
    if (out[openStart] === '_' && (/[A-Za-z0-9]/.test(prevChar) || /[A-Za-z0-9]/.test(nextChar))) {
      continue;
    }

    const marker = out[openStart] + out[openStart];
    const leadWs = mid.slice(0, lead);
    const trailWs = mid.slice(mid.length - trail);

    out = out.slice(0, openStart) + leadWs + marker + inner + marker + trailWs + out.slice(closeStart + markerLen);
  }
  return out;
}

/** Reflows spaces inside double-character formatting markers. */
export function normalizeMarkdownWhitespace(src: string): string {
  if (!src) return src;
  return reflowPairedSpaces(src);
}

/**
 * Guards out-of-subset image macros so they render verbatim. Disabling the
 * `image` rule alone is not enough: `![alt](url)` would still parse as `!`
 * followed by a normal `[alt](url)` link. Backslash-escaping the `[` keeps the
 * whole macro literal while other Markdown beside it parses normally.
 */
function escapeImageMacros(src: string, masked: boolean[]): string {
  const parts: string[] = [];
  let i = 0;
  let last = 0;
  while (i < src.length) {
    if (!masked[i] && i + 1 < src.length && src[i] === '!' && src[i + 1] === '[' && !masked[i + 1]) {
      parts.push(src.slice(last, i + 1)); // up to and including the `!`
      parts.push('\\');
      last = i + 1; // the `[` goes into the next segment
      i += 2;
    } else {
      i++;
    }
  }
  if (last < src.length) parts.push(src.slice(last));
  return parts.join('');
}

/** Full pre-parse normalization applied by the engine on every parse. */
export function normalizeMarkdownBeforeParse(src: string): string {
  if (!src) return src;
  const masked = maskCodeRegions(src);
  return normalizeMarkdownWhitespace(escapeImageMacros(src, masked));
}
