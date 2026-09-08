import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import type { Token } from 'markdown-it';

import { markdownEngine } from './engine';
import { containsPlaceholder, splitByPlaceholders } from './placeholder';

/**
 * Renders a markdown-it token stream as controlled React elements — never HTML
 * strings, never `dangerouslySetInnerHTML` — so raw HTML and `javascript:`-style
 * payloads stay inert. Interactive widgets (mentions / invite cards /
 * permalinks) are re-inserted at their placeholder slots inside `text` tokens
 * via {@link MarkdownRenderOptions.onPlaceholder}.
 */
export interface MarkdownRenderOptions {
  /** Restores a placeholder slot to its widget; not called for code content. */
  onPlaceholder?: (index: number) => ReactNode | null | undefined;
  /**
   * Custom anchor hook (invite / permalink widgets). Return `null`/`undefined`
   * to fall back to the default safe external anchor.
   */
  renderLink?: (href: string, label: ReactNode, token: Token) => ReactNode | null | undefined;
  /** Single-line context (chat-list previews): line breaks become spaces. */
  singleLine?: boolean;
}

/** Only absolute `http:`/`https:` hrefs may become links. */
export function isSafeLinkHref(href: string | null | undefined): href is string {
  if (!href) return false;
  return /^https?:\/\//i.test(href);
}

const stopPropagation = (event: { stopPropagation(): void }): void => {
  event.stopPropagation();
};

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Index of the token closing the container opened at `openIndex`, skipping
 * balanced nested containers of the same type.
 *
 * @internal exported for `preview.tsx`.
 */
export function findMatchingTokenEnd(tokens: readonly Token[], openIndex: number): number {
  const openType = tokens[openIndex]?.type ?? '';
  const closeType = openType.replace(/_open$/, '_close');
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const type = tokens[i].type;
    if (type === openType) {
      depth += 1;
    } else if (type === closeType) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function pushTextNodes(out: ReactNode[], text: string, options: MarkdownRenderOptions, nextKey: () => number): void {
  if (!text) return;
  if (!containsPlaceholder(text)) {
    out.push(text);
    return;
  }
  for (const part of splitByPlaceholders(text)) {
    if (typeof part === 'string') {
      if (part) out.push(part);
      continue;
    }
    const node = options.onPlaceholder?.(part.index);
    if (node != null) {
      // Keyed Fragment: sibling keys stay unique even if the widget brings keys.
      out.push(createElement(Fragment, { key: nextKey() }, node));
    }
  }
}

export function renderInlineTokens(tokens: readonly Token[], options: MarkdownRenderOptions = {}): ReactNode[] {
  const out: ReactNode[] = [];
  let keyCounter = 0;
  const nextKey = () => keyCounter++;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'text': {
        pushTextNodes(out, token.content, options, nextKey);
        i += 1;
        break;
      }
      case 'softbreak':
      case 'hardbreak': {
        out.push(options.singleLine ? ' ' : '\n');
        i += 1;
        break;
      }
      case 'code_inline': {
        out.push(createElement('code', { key: nextKey() }, token.content));
        i += 1;
        break;
      }
      case 'image': {
        const rawSrc = token.attrGet('src');
        const src = typeof rawSrc === 'string' ? rawSrc : null;
        const label = token.content || src || '';
        if (isSafeLinkHref(src)) {
          out.push(
            createElement(
              'a',
              {
                key: nextKey(),
                href: src,
                target: '_blank',
                rel: 'noopener noreferrer',
                onClick: stopPropagation,
              },
              label,
            ),
          );
        } else if (label) {
          // Unsafe src: render the alt text only.
          out.push(label);
        }
        i += 1;
        break;
      }
      case 'em_open':
      case 'strong_open':
      case 's_open':
      case 'u_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const tag =
          token.type === 'em_open'
            ? 'em'
            : token.type === 'strong_open'
              ? 'strong'
              : token.type === 's_open'
                ? 's'
                : 'u';
        const inner = renderInlineTokens(tokens.slice(i + 1, closeIndex), options);
        out.push(createElement(tag, { key: nextKey() }, inner));
        i = closeIndex + 1;
        break;
      }
      case 'link_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const rawHref = token.attrGet('href');
        const href = typeof rawHref === 'string' ? rawHref : null;
        const label = renderInlineTokens(tokens.slice(i + 1, closeIndex), options);
        const key = nextKey();
        if (isSafeLinkHref(href)) {
          const custom = options.renderLink?.(href, label, token);
          if (custom != null) {
            out.push(createElement(Fragment, { key }, custom));
          } else {
            out.push(
              createElement(
                'a',
                {
                  key,
                  href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  onClick: stopPropagation,
                },
                label,
              ),
            );
          }
        } else {
          // Downgrade unsafe / relative hrefs to plain text.
          out.push(createElement(Fragment, { key }, label));
        }
        i = closeIndex + 1;
        break;
      }
      case 'html_inline': {
        pushTextNodes(out, token.content, options, nextKey);
        i += 1;
        break;
      }
      default: {
        if (token.type.endsWith('_open')) {
          // Unknown container: keep its content without a wrapper.
          const closeIndex = findMatchingTokenEnd(tokens, i);
          const inner = renderInlineTokens(tokens.slice(i + 1, closeIndex), options);
          out.push(createElement(Fragment, { key: nextKey() }, inner));
          i = closeIndex + 1;
        } else {
          pushTextNodes(out, token.content, options, nextKey);
          i += 1;
        }
      }
    }
  }
  return out;
}

function blockInlineContent(inner: readonly Token[], options: MarkdownRenderOptions): ReactNode[] {
  const children: Token[] = [];
  for (const token of inner) {
    if (token.type === 'inline') {
      if (token.children) children.push(...token.children);
    } else {
      children.push(token);
    }
  }
  return renderInlineTokens(children, options);
}

function listItemSlices(inner: readonly Token[]): Token[][] {
  const items: Token[][] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i].type !== 'list_item_open') {
      i += 1;
      continue;
    }
    const closeIndex = findMatchingTokenEnd(inner, i);
    items.push(inner.slice(i + 1, closeIndex));
    i = closeIndex + 1;
  }
  return items;
}

function renderList(tokens: readonly Token[], openIndex: number, options: MarkdownRenderOptions): ReactNode {
  const token = tokens[openIndex];
  const closeIndex = findMatchingTokenEnd(tokens, openIndex);
  const items = listItemSlices(tokens.slice(openIndex + 1, closeIndex));
  const tag = token.type === 'ordered_list_open' ? 'ol' : 'ul';
  const ordered = token.type === 'ordered_list_open';

  const props: { start?: number; key: number } = { key: openIndex };
  if (ordered) {
    const start = token.attrGet('start');
    const startNumber = start == null ? NaN : Number(start);
    // The default renderer only emits `start` when it differs from 1.
    if (Number.isInteger(startNumber) && startNumber !== 1) props.start = startNumber;
  }

  return createElement(
    tag,
    props,
    items.map((slice, index) => createElement('li', { key: index }, renderBlocks(slice, options))),
  );
}

function renderBlocks(tokens: readonly Token[], options: MarkdownRenderOptions): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'paragraph_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const content = blockInlineContent(tokens.slice(i + 1, closeIndex), options);
        // Tight list paragraphs carry `hidden: true` and must not wrap <p>.
        out.push(token.hidden ? createElement(Fragment, { key: i }, content) : createElement('p', { key: i }, content));
        i = closeIndex + 1;
        break;
      }
      case 'heading_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const tag = token.tag;
        const content = blockInlineContent(tokens.slice(i + 1, closeIndex), options);
        out.push(createElement(HEADING_TAGS.has(tag) ? (tag as HeadingTag) : 'p', { key: i }, content));
        i = closeIndex + 1;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        out.push(renderList(tokens, i, options));
        i = findMatchingTokenEnd(tokens, i) + 1;
        break;
      }
      case 'blockquote_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const inner = renderBlocks(tokens.slice(i + 1, closeIndex), options);
        out.push(createElement('blockquote', { key: i }, inner));
        i = closeIndex + 1;
        break;
      }
      case 'fence':
      case 'code_block': {
        const language = token.info.trim().split(/\s+/, 1)[0];
        const className = language && /^[\w+-]+$/.test(language) ? `language-${language}` : undefined;
        const code = createElement('code', className ? { className } : null, token.content);
        out.push(createElement('pre', { key: i }, code));
        i += 1;
        break;
      }
      case 'hr': {
        out.push(createElement('hr', { key: i }));
        i += 1;
        break;
      }
      case 'inline': {
        out.push(...renderInlineTokens(token.children ?? [], options));
        i += 1;
        break;
      }
      case 'html_block': {
        const nodes: ReactNode[] = [];
        pushTextNodes(nodes, token.content, options, () => {
          const key = nodes.length;
          return key;
        });
        out.push(createElement(Fragment, { key: i }, nodes));
        i += 1;
        break;
      }
      default: {
        if (token.type.endsWith('_open')) {
          const closeIndex = findMatchingTokenEnd(tokens, i);
          out.push(createElement(Fragment, { key: i }, renderBlocks(tokens.slice(i + 1, closeIndex), options)));
          i = closeIndex + 1;
        } else {
          const nodes: ReactNode[] = [];
          pushTextNodes(nodes, token.content, options, () => nodes.length);
          out.push(...nodes);
          i += 1;
        }
      }
    }
  }
  return out;
}

export function renderMarkdownTokens(tokens: readonly Token[], options: MarkdownRenderOptions = {}): ReactNode[] {
  return renderBlocks(tokens, options);
}

export function renderMarkdownText(text: string, options: MarkdownRenderOptions = {}): ReactNode[] {
  return renderMarkdownTokens(markdownEngine.parse(text, {}), options);
}
