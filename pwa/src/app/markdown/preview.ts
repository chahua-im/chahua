import type { Token } from 'markdown-it';

import { markdownEngine } from './engine';
import { findMatchingTokenEnd, renderInlineTokens } from './nodes';
import type { MarkdownNode, MarkdownRenderOptions } from './nodes';

/**
 * Single-line Markdown preview: flattens block structure into inline content
 * so chat-list / thread previews can show rendered Markdown on one line. Line
 * breaks become spaces; truncation is left to CSS rather than slicing raw text
 * mid-marker.
 */

function inlineChildrenOf(inner: readonly Token[]): Token[] {
  const children: Token[] = [];
  for (const token of inner) {
    if (token.type === 'inline') {
      if (token.children) children.push(...token.children);
    } else {
      children.push(token);
    }
  }
  return children;
}

function previewBlocks(tokens: readonly Token[], options: MarkdownRenderOptions): MarkdownNode[] {
  const parts: MarkdownNode[] = [];

  const addUnit = (content: MarkdownNode[]): void => {
    if (parts.length) parts.push({ type: 'text', text: ' ' });
    parts.push(...content);
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'paragraph_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        addUnit(renderInlineTokens(inlineChildrenOf(tokens.slice(i + 1, closeIndex)), options));
        i = closeIndex + 1;
        break;
      }
      case 'heading_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        addUnit([
          {
            type: 'element',
            tag: 'strong',
            children: renderInlineTokens(inlineChildrenOf(tokens.slice(i + 1, closeIndex)), options),
          },
        ]);
        i = closeIndex + 1;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const inner = tokens.slice(i + 1, closeIndex);

        let itemNumber = 1;
        if (ordered) {
          const start = token.attrGet('start');
          const startNumber = start == null ? NaN : Number(start);
          if (Number.isInteger(startNumber) && startNumber >= 1) itemNumber = startNumber;
        }

        let j = 0;
        while (j < inner.length) {
          if (inner[j].type !== 'list_item_open') {
            j += 1;
            continue;
          }
          const itemEnd = findMatchingTokenEnd(inner, j);
          const itemContent = previewBlocks(inner.slice(j + 1, itemEnd), options);
          if (parts.length) parts.push({ type: 'text', text: ' ' });
          parts.push({ type: 'text', text: ordered ? itemNumber + '. ' : '• ' });
          parts.push(...itemContent);
          itemNumber += 1;
          j = itemEnd + 1;
        }
        i = closeIndex + 1;
        break;
      }
      case 'fence':
      case 'code_block': {
        const text = token.content.replace(/\s*\n+\s*/g, ' ').trim();
        if (text) addUnit([{ type: 'element', tag: 'code', children: [{ type: 'text', text }] }]);
        i += 1;
        break;
      }
      case 'inline': {
        addUnit(renderInlineTokens(token.children ?? [], options));
        i += 1;
        break;
      }
      default: {
        if (token.type.endsWith('_open')) {
          const closeIndex = findMatchingTokenEnd(tokens, i);
          addUnit(previewBlocks(tokens.slice(i + 1, closeIndex), options));
          i = closeIndex + 1;
        } else {
          i += 1;
        }
      }
    }
  }
  return parts;
}

export function renderMarkdownPreview(text: string, options: MarkdownRenderOptions = {}): MarkdownNode[] {
  if (!text) return [];
  const singleLine: MarkdownRenderOptions = { ...options, singleLine: true };
  return previewBlocks(markdownEngine.parse(text, {}), singleLine);
}
