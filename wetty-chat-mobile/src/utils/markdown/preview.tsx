import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import type { Token } from 'markdown-it';

import { markdownEngine } from './engine';
import { findMatchingTokenEnd, renderInlineTokens } from './react-renderer';
import type { MarkdownRenderOptions } from './react-renderer';

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

function previewBlocks(tokens: readonly Token[], options: MarkdownRenderOptions): ReactNode[] {
  const parts: ReactNode[] = [];
  let unitNo = 0;

  const addUnit = (content: ReactNode): void => {
    if (unitNo > 0) parts.push(' ');
    parts.push(createElement(Fragment, { key: unitNo }, content));
    unitNo += 1;
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'paragraph_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const content = renderInlineTokens(
          inlineChildrenOf(tokens.slice(i + 1, closeIndex)),
          options,
        );
        addUnit(content);
        i = closeIndex + 1;
        break;
      }
      case 'heading_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const content = renderInlineTokens(
          inlineChildrenOf(tokens.slice(i + 1, closeIndex)),
          options,
        );
        addUnit(createElement('strong', null, content));
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

        const listNodes: ReactNode[] = [];
        let j = 0;
        while (j < inner.length) {
          if (inner[j].type !== 'list_item_open') {
            j += 1;
            continue;
          }
          const itemEnd = findMatchingTokenEnd(inner, j);
          const itemContent = previewBlocks(inner.slice(j + 1, itemEnd), options);
          if (listNodes.length > 0) listNodes.push(' ');
          listNodes.push(ordered ? `${itemNumber}. ` : '• ');
          listNodes.push(createElement(Fragment, { key: `li-${j}` }, itemContent));
          itemNumber += 1;
          j = itemEnd + 1;
        }
        addUnit(listNodes);
        i = closeIndex + 1;
        break;
      }
      case 'blockquote_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        addUnit(previewBlocks(tokens.slice(i + 1, closeIndex), options));
        i = closeIndex + 1;
        break;
      }
      case 'fence':
      case 'code_block': {
        const text = token.content.replace(/\s*\n+\s*/g, ' ').trim();
        if (text) addUnit(createElement('code', null, text));
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

export function renderMarkdownPreview(
  text: string,
  options: MarkdownRenderOptions = {},
): ReactNode[] {
  if (!text) return [];
  const singleLine: MarkdownRenderOptions = { ...options, singleLine: true };
  return previewBlocks(markdownEngine.parse(text, {}), singleLine);
}
