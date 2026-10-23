import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';
import { applyChatBlocks } from './chat-blocks';

/** Chat subset: exact double stars for bold, double underscores for italic. */
const STAR = 0x2a;
const UNDERLINE = 0x5f;
const PIPE = 0x7c;

function strongTokenize(state: StateInline, silent: boolean): boolean {
  if (silent || state.src.charCodeAt(state.pos) !== STAR) return false;
  const scanned = state.scanDelims(state.pos, true);
  const token = state.push('text', '', 0);
  token.content = '*'.repeat(scanned.length);
  // Consume other runs intact so neither single nor triple stars become emphasis.
  if (scanned.length === 2) {
    state.delimiters.push({
      marker: STAR,
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

function strongPostProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
  for (const start of delimiters) {
    if (start.marker !== STAR || start.end === -1) continue;
    const end = delimiters[start.end];
    const open = state.tokens[start.token];
    open.type = 'strong_open';
    open.tag = 'strong';
    open.nesting = 1;
    open.markup = '**';
    open.content = '';
    const close = state.tokens[end.token];
    close.type = 'strong_close';
    close.tag = 'strong';
    close.nesting = -1;
    close.markup = '**';
    close.content = '';
  }
}

function strongPost(state: StateInline): void {
  strongPostProcess(state, state.delimiters);
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters) strongPostProcess(state, meta.delimiters);
  }
}

/** Double underscores produce italic; a single underscore stays literal. */
function underscoreItalicTokenize(state: StateInline, silent: boolean): boolean {
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

function underscoreItalicPostProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
  let token;
  const loneMarkers: number[] = [];
  const max = delimiters.length;
  for (let i = 0; i < max; i++) {
    const startDelim = delimiters[i];
    if (startDelim.marker !== UNDERLINE) continue;
    if (startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];
    token = state.tokens[startDelim.token];
    token.type = 'em_open';
    token.tag = 'em';
    token.nesting = 1;
    token.markup = '__';
    token.content = '';
    token = state.tokens[endDelim.token];
    token.type = 'em_close';
    token.tag = 'em';
    token.nesting = -1;
    token.markup = '__';
    token.content = '';
    if (state.tokens[endDelim.token - 1].type === 'text' && state.tokens[endDelim.token - 1].content === '_') {
      loneMarkers.push(endDelim.token - 1);
    }
  }
  while (loneMarkers.length) {
    const i = loneMarkers.pop() as number;
    let j = i + 1;
    while (j < state.tokens.length && state.tokens[j].type === 'em_close') j++;
    j--;
    if (i !== j) {
      token = state.tokens[j];
      state.tokens[j] = state.tokens[i];
      state.tokens[i] = token;
    }
  }
}

function underscoreItalicPost(state: StateInline): void {
  const tokensMeta = state.tokens_meta;
  const max = state.tokens_meta.length;
  underscoreItalicPostProcess(state, state.delimiters);
  for (let curr = 0; curr < max; curr++) {
    const delimiters = tokensMeta[curr]?.delimiters;
    if (delimiters) underscoreItalicPostProcess(state, delimiters);
  }
}

/* ---------------------------------------------------------------------------
 * `||` spoiler — the same machinery as the underscore rule with the `|`
 * marker. A run of two renders a click-to-reveal span; single `|` stays
 * literal text.
 * ------------------------------------------------------------------------- */

/**
 * CommonMark flanking would keep `||` from opening right before punctuation
 * (`你好||**粗体**||`) or closing right after it (`||**粗体**||你好`), because
 * emphasis markers read as punctuation. A chat spoiler only cares about
 * whitespace: it opens unless followed by whitespace and closes unless preceded
 * by one.
 */
function spoilerTokenize(isWhiteSpace: (code: number) => boolean): (state: StateInline, silent: boolean) => boolean {
  return function spoiler(state, silent) {
    if (silent) return false;
    if (state.src.charCodeAt(state.pos) !== PIPE) return false;
    const scanned = state.scanDelims(state.pos, true);
    let len = scanned.length;
    const ch = String.fromCharCode(PIPE);
    if (len < 2) return false;
    const before = state.pos > 0 ? state.src.charCodeAt(state.pos - 1) : SPACE;
    const after = state.pos + len < state.posMax ? state.src.charCodeAt(state.pos + len) : SPACE;
    const open = !isWhiteSpace(after);
    const close = !isWhiteSpace(before);
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
        marker: PIPE,
        length: 0,
        token: state.tokens.length - 1,
        end: -1,
        open,
        close,
      });
    }
    state.pos += scanned.length;
    return true;
  };
}

function spoilerPostProcess(state: StateInline, delimiters: StateInline['delimiters']): void {
  let token;
  const max = delimiters.length;
  for (let i = 0; i < max; i++) {
    const startDelim = delimiters[i];
    if (startDelim.marker !== PIPE) continue;
    if (startDelim.end === -1) continue;
    const endDelim = delimiters[startDelim.end];
    token = state.tokens[startDelim.token];
    token.type = 'spoiler_open';
    token.tag = 'span';
    token.nesting = 1;
    token.markup = '||';
    token.content = '';
    token = state.tokens[endDelim.token];
    token.type = 'spoiler_close';
    token.tag = 'span';
    token.nesting = -1;
    token.markup = '||';
    token.content = '';
  }
}

function spoilerPost(state: StateInline): void {
  const tokensMeta = state.tokens_meta;
  const max = state.tokens_meta.length;
  spoilerPostProcess(state, state.delimiters);
  for (let curr = 0; curr < max; curr++) {
    const delimiters = tokensMeta[curr]?.delimiters;
    if (delimiters) spoilerPostProcess(state, delimiters);
  }
}

/* ---------------------------------------------------------------------------
 * Subset configuration for the whole engine.
 * ------------------------------------------------------------------------- */

/**
 * Rules disabled so their syntax renders as literal text. Blockquotes, headings, horizontal
 * rules, images, reference links, autolinks, HTML and entities are NOT part of
 * chahua's subset.
 */
const DISABLED_RULES = [
  // block
  'blockquote',
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

interface InlineRulerInternals {
  __rules__: { name: string; fn: (state: StateInline, silent: boolean) => boolean }[];
}

const SPACE = 0x20;
const TAB = 0x09;

/**
 * Wraps the native `list` rule so a line starting with a `* ` bullet (or a
 * lone `*`) is NOT a list. Dash/plus and numbered lists remain supported.
 * Returning `false` lets the lower-priority
 * rules (paragraph) render the line literally, in every context the native
 * list rule is consulted (top level, nested items...).
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

/* markdown-it's `text` rule scans runs up to its own terminator set, which
 * does not include `|` — so `||spoiler||` would be swallowed whole before
 * the spoiler rule ever runs. Re-register it with a copy of the stock rule
 * whose terminator set also stops at `|`.
 */
const TEXT_TERMINATORS = new Set([
  0x0a, 0x21, 0x23, 0x24, 0x25, 0x26, 0x2a, 0x2b, 0x2d, 0x3a, 0x3c, 0x3d, 0x3e, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x7b, 0x7c, 0x7d, 0x7e,
]);

function pipeAwareTextTokenize(state: StateInline, silent: boolean): boolean {
  let pos = state.pos;
  while (pos < state.posMax && !TEXT_TERMINATORS.has(state.src.charCodeAt(pos))) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, pos);
  state.pos = pos;
  return true;
}

export function applyMarkdownSubset(md: MarkdownIt): void {
  md.disable(DISABLED_RULES, true);
  applyChatBlocks(md);

  // A chat newline never consumes neighboring spaces or a literal backslash.
  md.inline.ruler.at('newline', (state, silent) => {
    if (state.src[state.pos] !== '\n') return false;
    if (!silent) state.push('softbreak', 'br', 0);
    state.pos++;
    return true;
  });
  md.inline.ruler.before('escape', 'literalLineBackslash', (state, silent) => {
    if (state.src[state.pos] !== '\\' || state.src[state.pos + 1] !== '\n') return false;
    if (!silent) state.pending += '\\';
    state.pos++;
    return true;
  });

  // Reuse code-span matching but keep its source whitespace, including newlines.
  const inlineRuler = md.inline.ruler as unknown as InlineRulerInternals;
  const backticks = inlineRuler.__rules__.find((rule) => rule.name === 'backticks')!.fn;
  md.inline.ruler.at('backticks', (state, silent) => {
    const start = state.pos;
    const previousToken = state.tokens.at(-1);
    const matched = backticks(state, silent);
    if (matched && !silent) {
      const token = state.tokens.at(-1);
      if (token?.type === 'code_inline' && token !== previousToken) {
        token.content = state.src.slice(start + token.markup.length, state.pos - token.markup.length);
      }
    }
    return matched;
  });

  // Keep the text rule ahead of the spoiler rule (see note above).
  md.inline.ruler.at('text', pipeAwareTextTokenize);

  // Only exact double-star runs produce bold.
  md.inline.ruler.at('emphasis', strongTokenize);
  md.inline.ruler2.at('emphasis', strongPost);

  // `__` italic (must pair after balance_pairs but before fragments_join).
  md.inline.ruler.before('link', 'underscoreItalic', underscoreItalicTokenize);
  md.inline.ruler2.before('fragments_join', 'underscoreItalic', underscoreItalicPost);

  // `||spoiler||`.
  md.inline.ruler.before('link', 'spoiler', spoilerTokenize(md.utils.isWhiteSpace));
  md.inline.ruler2.before('fragments_join', 'spoiler', spoilerPost);

  // Tilde runs remain literal rather than opening code fences.
  const ruler = md.block.ruler as unknown as BlockRulerInternals;
  const fenceRule = ruler.__rules__.find((rule) => rule.name === 'fence')!;
  const nativeFence = fenceRule.fn;
  md.block.ruler.at(
    'fence',
    (state, start, end, silent) => {
      const pos = state.bMarks[start] + state.tShift[start];
      return state.src[pos] === '`' && nativeFence(state, start, end, silent);
    },
    { alt: fenceRule.alt },
  );

  // `*` is not a list marker.
  const listRule = ruler.__rules__.find((rule) => rule.name === 'list');
  if (listRule) {
    md.block.ruler.at('list', starAwareListRule(listRule.fn), { alt: listRule.alt });
  }
}
