import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

/**
 * Custom inline rules for chahua's Markdown subset. markdown-it's default
 * emphasis treats both `*` and `_` as markers; chahua keeps `*` / `**` for
 * emphasis only and repurposes `__…__` as underline (`<u>`), leaving single
 * `_` literal. `~~strike~~` keeps markdown-it's stock rule.
 *
 * `emphasis` is re-registered with a `*`-only clone of markdown-it's own
 * machinery; `underline` is a new rule modelled on its strikethrough.
 */

const STAR = 0x2a; // *
const UNDERLINE = 0x5f; // _

/* ---------------------------------------------------------------------------
 * `*` / `**` emphasis — clone of markdown-it's rules_inline/emphasis.ts,
 * restricted to the `*` marker.
 * ------------------------------------------------------------------------- */

function starEmphasisTokenize(state: StateInline, silent: boolean): boolean {
  if (silent) return false;
  const marker = state.src.charCodeAt(state.pos);
  if (marker !== STAR) return false;
  const scanned = state.scanDelims(state.pos, true);
  for (let i = 0; i < scanned.length; i++) {
    const token = state.push('text', '', 0);
    token.content = String.fromCharCode(marker);
    state.delimiters.push({
      marker,
      length: scanned.length,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += scanned.length;
  return true;
}

function starEmphasisPostProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
  const max = delimiters.length;
  for (let i = max - 1; i >= 0; i--) {
    const startDelim = delimiters[i];
    if (startDelim.marker !== STAR) continue;
    if (startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];
    const isStrong =
      i > 0 &&
      delimiters[i - 1].end === startDelim.end + 1 &&
      delimiters[i - 1].marker === startDelim.marker &&
      delimiters[i - 1].token === startDelim.token - 1 &&
      delimiters[startDelim.end + 1].token === endDelim.token + 1;
    const ch = String.fromCharCode(startDelim.marker);
    const tokenOpen = state.tokens[startDelim.token];
    tokenOpen.type = isStrong ? 'strong_open' : 'em_open';
    tokenOpen.tag = isStrong ? 'strong' : 'em';
    tokenOpen.nesting = 1;
    tokenOpen.markup = isStrong ? ch + ch : ch;
    tokenOpen.content = '';
    const tokenClose = state.tokens[endDelim.token];
    tokenClose.type = isStrong ? 'strong_close' : 'em_close';
    tokenClose.tag = isStrong ? 'strong' : 'em';
    tokenClose.nesting = -1;
    tokenClose.markup = isStrong ? ch + ch : ch;
    tokenClose.content = '';
    if (isStrong) {
      state.tokens[delimiters[i - 1].token].content = '';
      state.tokens[delimiters[startDelim.end + 1].token].content = '';
      i--;
    }
  }
}

function starEmphasisPost(state: StateInline): void {
  const tokensMeta = state.tokens_meta;
  const max = state.tokens_meta.length;
  starEmphasisPostProcess(state, state.delimiters);
  for (let curr = 0; curr < max; curr++) {
    const delimiters = tokensMeta[curr]?.delimiters;
    if (delimiters) starEmphasisPostProcess(state, delimiters);
  }
}

/* ---------------------------------------------------------------------------
 * `__` underline — clone of markdown-it's rules_inline/strikethrough.ts using
 * the `_` marker. Single `_` is not tokenized and stays literal text.
 * ------------------------------------------------------------------------- */

function underlineTokenize(state: StateInline, silent: boolean): boolean {
  if (silent) return false;
  const marker = state.src.charCodeAt(state.pos);
  if (marker !== UNDERLINE) return false;
  const scanned = state.scanDelims(state.pos, true);
  let len = scanned.length;
  const ch = String.fromCharCode(marker);
  if (len < 2) return false;
  let token;
  if (len % 2) {
    token = state.push('text', '', 0);
    token.content = ch;
    len--;
  }
  for (let i = 0; i < len; i += 2) {
    token = state.push('text', '', 0);
    token.content = ch + ch;
    state.delimiters.push({
      marker,
      length: 0,
      token: state.tokens.length - 1,
      end: -1,
      open: scanned.can_open,
      close: scanned.can_close,
    });
  }
  state.pos += scanned.length;
  return true;
}

function underlinePostProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
  let token;
  const loneMarkers: number[] = [];
  const max = delimiters.length;
  for (let i = 0; i < max; i++) {
    const startDelim = delimiters[i];
    if (startDelim.marker !== UNDERLINE) continue;
    if (startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];
    token = state.tokens[startDelim.token];
    token.type = 'u_open';
    token.tag = 'u';
    token.nesting = 1;
    token.markup = '__';
    token.content = '';
    token = state.tokens[endDelim.token];
    token.type = 'u_close';
    token.tag = 'u';
    token.nesting = -1;
    token.markup = '__';
    token.content = '';
    if (
      state.tokens[endDelim.token - 1].type === 'text' &&
      state.tokens[endDelim.token - 1].content === '_'
    ) {
      loneMarkers.push(endDelim.token - 1);
    }
  }
  while (loneMarkers.length) {
    const i = loneMarkers.pop() as number;
    let j = i + 1;
    while (j < state.tokens.length && state.tokens[j].type === 'u_close') j++;
    j--;
    if (i !== j) {
      token = state.tokens[j];
      state.tokens[j] = state.tokens[i];
      state.tokens[i] = token;
    }
  }
}

function underlinePost(state: StateInline): void {
  const tokensMeta = state.tokens_meta;
  const max = state.tokens_meta.length;
  underlinePostProcess(state, state.delimiters);
  for (let curr = 0; curr < max; curr++) {
    const delimiters = tokensMeta[curr]?.delimiters;
    if (delimiters) underlinePostProcess(state, delimiters);
  }
}

/* ---------------------------------------------------------------------------
 * Subset configuration for the whole engine.
 * ------------------------------------------------------------------------- */

/**
 * Rules disabled so their syntax renders as literal text. Headings, horizontal
 * rules, images, reference links, autolinks, HTML and entities are NOT part of
 * chahua's subset.
 */
const DISABLED_RULES = [
  // block
  'table',
  'code', // 4-space indented code block
  'hr',
  'reference',
  'html_block',
  'heading',
  'lheading',
  // inline
  'image',
  'autolink',
  'html_inline',
  'entity',
];

/* markdown-it keeps the block rules behind a semi-public Ruler instance. We
 * only need it to swap the `list` rule, so poke through its `__rules__` list
 * (an established pattern used by many markdown-it plugins). */
interface InternalBlockRule {
  name: string;
  enabled: boolean;
  fn: (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;
  alt: string[];
}
interface BlockRulerInternals {
  __rules__: InternalBlockRule[];
}

const SPACE = 0x20;
const TAB = 0x09;

/**
 * Wraps the native `list` rule so a line starting with a `* ` bullet (or a
 * lone `*`) is NOT a list. `*` is reserved for emphasis in chahua's subset;
 * only `-` and `1.` start lists. Returning `false` lets the lower-priority
 * rules (paragraph) render the line literally, in every context the native
 * list rule is consulted (top level, inside blockquotes, nested items...).
 */
function starAwareListRule(
  nativeList: InternalBlockRule['fn'],
): (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean {
  return function listWithoutStarBullets(state, startLine, endLine, silent) {
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    if (state.src.charCodeAt(pos) === STAR) {
      const max = state.eMarks[startLine];
      const after = pos + 1;
      if (after >= max || state.src.charCodeAt(after) === SPACE || state.src.charCodeAt(after) === TAB) {
        return false;
      }
    }
    return nativeList(state, startLine, endLine, silent);
  };
}

export function applyMarkdownSubset(md: MarkdownIt): void {
  md.disable(DISABLED_RULES, true);

  // `*`-only emphasis.
  md.inline.ruler.at('emphasis', starEmphasisTokenize);
  md.inline.ruler2.at('emphasis', starEmphasisPost);

  // `__` underline (must pair after balance_pairs but before fragments_join).
  md.inline.ruler.before('link', 'underline', underlineTokenize);
  md.inline.ruler2.before('fragments_join', 'underline', underlinePost);

  // `*` is not a list marker.
  const ruler = md.block.ruler as unknown as BlockRulerInternals;
  const listRule = ruler.__rules__.find((rule) => rule.name === 'list');
  if (listRule) {
    md.block.ruler.at('list', starAwareListRule(listRule.fn), { alt: listRule.alt });
  }
}
