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
 * single-`*` italic forgives one side only so arithmetic-like `5 * 3 * 4` is
 * never altered. Code spans, fences, escaped characters and multi-line
 * content are skipped.
 */

/** Returns a mask of character indexes inside code spans/fences or escapes. */
function maskCodeRegions(src: string): boolean[] {
  const n = src.length;
  const masked = new Array<boolean>(n).fill(false);
  const atLineStart = (idx: number): boolean => idx === 0 || src[idx - 1] === '\n';

  const maskRange = (from: number, to: number): void => {
    for (let x = from; x < to && x < n; x++) masked[x] = true;
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < n) {
      masked[i] = true;
      masked[i + 1] = true;
      i += 2;
      continue;
    }

    // Fenced code block: a line with ≤3 leading spaces whose first non-space
    // chars are a fence run (``` or ~~~, ≥3). Mask through the closing fence;
    // an unclosed fence masks to EOF.
    if (atLineStart(i) && (ch === ' ' || ch === '\t' || ch === '`' || ch === '~')) {
      let probe = i;
      let lead = 0;
      while (probe < n && (src[probe] === ' ' || src[probe] === '\t') && lead < 3) {
        probe++;
        lead++;
      }
      if (probe < n && (src[probe] === '`' || src[probe] === '~')) {
        const fenceChar = src[probe];
        let run = probe;
        while (run < n && src[run] === fenceChar) run++;
        const openLen = run - probe;
        if (openLen >= 3) {
          let lineEnd = run;
          while (lineEnd < n && src[lineEnd] !== '\n') lineEnd++;
          maskRange(i, lineEnd);
          // Closing fence must live on a later line than the opening one.
          let cursor = lineEnd < n ? lineEnd + 1 : n;
          while (cursor < n) {
            let e = cursor;
            while (e < n && src[e] !== '\n') e++;
            let p2 = cursor;
            let l2 = 0;
            while (p2 < e && (src[p2] === ' ' || src[p2] === '\t') && l2 < 3) {
              p2++;
              l2++;
            }
            let isClosing = false;
            if (p2 < e && src[p2] === fenceChar) {
              let r2 = p2;
              while (r2 < e && src[r2] === fenceChar) r2++;
              if (r2 - p2 >= openLen) {
                let t2 = r2;
                while (t2 < e && (src[t2] === ' ' || src[t2] === '\t')) t2++;
                isClosing = t2 === e; // only trailing spaces may follow the fence
              }
            }
            maskRange(cursor, e);
            cursor = e < n ? e + 1 : n;
            if (isClosing) break;
          }
          i = cursor;
          continue;
        }
      }
    }

    // Inline code span: a run of L backticks closes at the next run of exactly
    // L backticks on the same line; unclosed spans stay unmasked.
    if (ch === '`') {
      let run = i;
      while (run < n && src[run] === '`') run++;
      const L = run - i;
      let j = run;
      let closeAt = -1;
      while (j < n) {
        if (src[j] === '`') {
          let rr = j;
          while (rr < n && src[rr] === '`') rr++;
          if (rr - j === L) {
            closeAt = j;
            break;
          }
          j = rr;
        } else {
          j++;
        }
      }
      if (closeAt === -1) {
        i = run;
        continue;
      }
      maskRange(i, closeAt + L);
      i = closeAt + L;
      continue;
    }

    i++;
  }
  return masked;
}

interface MarkerRun {
  start: number;
  ch: string;
}

type ReflowMode = 'two' | 'one';

function collectPairs(src: string, masked: boolean[], mode: ReflowMode): Array<[number, number]> {
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
    // `two`: exact `**`/`~~`/`__` runs. `one`: isolated single `*` only.
    if (len === (mode === 'two' ? 2 : 1) && (mode === 'one' ? ch === '*' : true)) {
      runs.push({ start: i, ch });
    }
    i = j;
  }

  const pairs: Array<[number, number]> = [];
  for (let t = 0; t + 1 < runs.length; t += 2) {
    pairs.push([runs[t].start, runs[t + 1].start]);
  }
  return pairs;
}

/**
 * Moves redundant spaces directly inside a paired marker to its outside.
 * `two` (`**`/`~~`/`__`) forgives spaces on either inner side; `one` (`*…*`)
 * forgives a stray space on one side only, so `5 * 3 * 4` keeps literal stars.
 */
function reflowPairedSpaces(src: string, mode: ReflowMode): string {
  if (!src) return src;
  const masked = maskCodeRegions(src);
  const pairs = collectPairs(src, masked, mode);
  const markerLen = mode === 'two' ? 2 : 1;

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
    if (mode === 'one' && lead > 0 && trail > 0) continue; // `5 * 3 * 4` stays literal

    // Digits adjacent to the markers or numeric-only content stay literal too.
    const prevChar = openStart > 0 ? out[openStart - 1] : '';
    const nextChar = closeStart + markerLen < out.length ? out[closeStart + markerLen] : '';
    if (/[0-9]/.test(prevChar) || /[0-9]/.test(nextChar)) continue;
    if (mode === 'one' && /^[0-9][0-9.,%]*$/.test(inner)) continue;
    if (mode === 'two' && out[openStart] === '_' && (/[A-Za-z0-9]/.test(prevChar) || /[A-Za-z0-9]/.test(nextChar))) {
      continue;
    }

    const marker = mode === 'two' ? out[openStart] + out[openStart] : '*';
    const leadWs = mid.slice(0, lead);
    const trailWs = mid.slice(mid.length - trail);

    out = out.slice(0, openStart) + leadWs + marker + inner + marker + trailWs + out.slice(closeStart + markerLen);
  }
  return out;
}

/** Reflows `**`/`~~`/`__` first, then single-`*` italic on the result. */
export function normalizeMarkdownWhitespace(src: string): string {
  if (!src) return src;
  return reflowPairedSpaces(reflowPairedSpaces(src, 'two'), 'one');
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
