import type { Token } from 'markdown-it';

/**
 * Token types that route a message through the Markdown renderer. Messages
 * producing none of them stay on the legacy plain-text path.
 */
const MEANINGFUL_TOKEN_TYPES = new Set<string>([
  // Inline formatting
  'em_open',
  'strong_open',
  's_open',
  'u_open',
  'code_inline',
  'link_open',
  'autolink',
  'image',
  // Block structure
  'heading_open',
  'bullet_list_open',
  'ordered_list_open',
  'blockquote_open',
  'hr',
  'fence',
  'code_block',
]);

function walkTokens(tokens: readonly Token[], visit: (token: Token) => void, includeChildren: boolean): void {
  for (const token of tokens) {
    visit(token);
    if (includeChildren && token.children) walkTokens(token.children, visit, true);
  }
}

export function tokensContainMarkup(tokens: readonly Token[]): boolean {
  let hit = false;
  walkTokens(
    tokens,
    (token) => {
      if (!hit && MEANINGFUL_TOKEN_TYPES.has(token.type)) hit = true;
    },
    true,
  );
  return hit;
}

/**
 * True when the body needs block layout: a heading / list / quote / fence /
 * code block / hr, or more than one paragraph. Purely inline formatting stays
 * inline.
 */
export function tokensContainBlocks(tokens: readonly Token[]): boolean {
  let paragraphs = 0;
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph_open':
        paragraphs += 1;
        if (paragraphs > 1) return true;
        break;
      case 'heading_open':
      case 'bullet_list_open':
      case 'ordered_list_open':
      case 'blockquote_open':
      case 'hr':
      case 'fence':
      case 'code_block':
        return true;
      default:
        break;
    }
  }
  return false;
}
