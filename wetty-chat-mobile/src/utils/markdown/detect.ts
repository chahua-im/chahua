import type { Token } from 'markdown-it';
import { markdownEngine } from './engine';
import { tokensContainMarkup } from './tokens';

// CommonMark "ASCII punctuation": the only characters a backslash may escape.
const ESCAPABLE_ASCII_PUNCT = `!"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~`;

export function hasEscapedPunctuation(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '\\') continue;
    if (ESCAPABLE_ASCII_PUNCT.indexOf(text[i + 1]) !== -1) return true;
  }
  return false;
}

/**
 * Decides whether a message needs the Markdown renderer, reusing a token list
 * the caller has already parsed so one parse feeds both this check and the
 * render. Escaped punctuation (`\*literal\*`) produces no markup token, yet the
 * backslash must still be stripped, so it is detected from the raw text too.
 */
export function hasMarkdownText(text: string, tokens: readonly Token[]): boolean {
  return hasEscapedPunctuation(text) || tokensContainMarkup(tokens);
}

export function messageHasMarkdown(text: string): boolean {
  if (!text) return false;
  return hasMarkdownText(text, markdownEngine.parse(text, {}));
}
