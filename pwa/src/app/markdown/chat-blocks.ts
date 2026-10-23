import type { MarkdownIt, StateBlock, Token } from 'markdown-it';

/** Ordinary chat text spans blank lines; only lists and fences end a text region. */
function chatParagraph(state: StateBlock, startLine: number, endLine: number): boolean {
  const terminators = state.md.block.ruler.getRules('paragraph');
  let nextLine = startLine + 1;
  for (; nextLine < endLine; nextLine++) {
    if (state.isEmpty(nextLine)) continue;
    // List continuations must stay inside the item's indentation.
    if (state.sCount[nextLine] < state.blkIndent) break;
    if (terminators.some((rule) => rule(state, nextLine, endLine, true))) break;
  }

  // Leave blank lines at structural boundaries to the shared spacing pass.
  const reachesEnd = nextLine === endLine && state.level === 0;
  let contentEnd = nextLine;
  if (!reachesEnd) {
    while (contentEnd > startLine + 1 && state.isEmpty(contentEnd - 1)) contentEnd--;
  }
  const contentStart = state.tokens.length === 0 ? 0 : startLine;
  state.line = contentEnd;
  const open = state.push('paragraph_open', 'p', 1);
  open.map = [contentStart, contentEnd];
  const inline = state.push('inline', '', 0);
  inline.map = [contentStart, contentEnd];
  inline.content = state.getLines(contentStart, contentEnd, state.blkIndent, reachesEnd);
  inline.children = [];
  state.push('paragraph_close', 'p', -1);
  return true;
}

function closingIndex(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    depth += tokens[i].nesting;
    if (depth === 0) return i;
  }
  return tokens.length;
}

/** Restore blank rows skipped by the block parser, including between list items. */
export function applyChatBlocks(md: MarkdownIt): void {
  md.block.ruler.at('paragraph', chatParagraph);
  md.core.ruler.after('block', 'chat_spacing', (state) => {
    if (state.inlineMode) return;
    const lines = state.src.split('\n');
    const contentEnd = (token: Token): number => {
      let end = token.map![1];
      if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open' || token.type === 'list_item_open') {
        while (end > token.map![0] + 1 && /^[\t ]*$/.test(lines[end - 1])) end--;
      }
      return end;
    };
    const gap = (count: number): Token => {
      const token = new state.Token('chat_gap', '', 0);
      token.content = '\n'.repeat(count);
      token.block = true;
      return token;
    };
    const restore = (tokens: Token[], startLine: number, inList = false): Token[] => {
      const out: Token[] = [];
      let cursor = startLine;
      for (let i = 0; i < tokens.length;) {
        const token = tokens[i];
        const end = token.nesting === 1 ? closingIndex(tokens, i) : i;
        if (token.map) {
          const blankLines = token.map[0] - cursor;
          if (blankLines > 0) {
            // A list may only contain li elements; put the gap after the previous item's content.
            out.splice(inList && out.length ? out.length - 1 : out.length, 0, gap(blankLines));
          }
          cursor = contentEnd(token);
        }
        out.push(token);
        if (token.nesting === 1) {
          const inner = tokens.slice(i + 1, end);
          const list = token.type === 'bullet_list_open' || token.type === 'ordered_list_open';
          out.push(...(list || token.type === 'list_item_open' ? restore(inner, token.map![0], list) : inner));
          out.push(tokens[end]);
        }
        i = end + 1;
      }
      return out;
    };
    state.tokens = restore(state.tokens, 0);
  });
  md.renderer.rules['chat_gap'] = (tokens, index) =>
    '<div class="chat-line-gap">' + '<br>'.repeat(tokens[index].content.length) + '</div>\n';
}
