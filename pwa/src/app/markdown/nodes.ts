import type { Token } from 'markdown-it';

import { markdownEngine } from './engine';
import { containsPlaceholder, splitByPlaceholders } from './placeholder';

/**
 * Framework-agnostic render tree produced from a markdown-it token stream.
 * The {@link MarkdownBody} component turns this tree into DOM — never HTML
 * strings, never innerHTML — so raw HTML and javascript-style payloads stay
 * inert. Interactive widgets (mentions) are re-inserted at their placeholder
 * slots inside text tokens via {@link MarkdownRenderOptions.onPlaceholder}.
 */
export type MarkdownNode =
  | { type: 'text'; text: string }
  | { type: 'element'; tag: string; attrs?: Readonly<Record<string, string>>; children: MarkdownNode[] }
  | { type: 'mention'; uid: number; name: string; self: boolean; clickable: boolean }
  /** Caller-defined widget restored from a placeholder slot. */
  | { type: 'widget'; index: number; node: MarkdownNode };

export interface MarkdownRenderOptions {
  /** Restores a placeholder slot to its widget; not called for code content. */
  onPlaceholder?: (index: number) => MarkdownNode | null | undefined;
  /**
   * Custom anchor hook. Return null/undefined to fall back to the default
   * safe external anchor.
   */
  renderLink?: (href: string, label: MarkdownNode[], token: Token) => MarkdownNode | null | undefined;
  /** Single-line context (chat-list previews): line breaks become spaces. */
  singleLine?: boolean;
}

/** Only absolute http:/https: hrefs may become links. */
export function isSafeLinkHref(href: string | null | undefined): href is string {
  if (!href) return false;
  return /^https?:\/\//i.test(href);
}

/**
 * Index of the token closing the container opened at openIndex, skipping
 * balanced nested containers of the same type.
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

function pushTextNodes(out: MarkdownNode[], text: string, options: MarkdownRenderOptions): void {
  if (!text) return;
  if (!containsPlaceholder(text)) {
    out.push({ type: 'text', text });
    return;
  }
  for (const part of splitByPlaceholders(text)) {
    if (typeof part === 'string') {
      if (part) out.push({ type: 'text', text: part });
      continue;
    }
    const node = options.onPlaceholder?.(part.index);
    if (node != null) out.push({ type: 'widget', index: part.index, node });
  }
}

export function renderInlineTokens(tokens: readonly Token[], options: MarkdownRenderOptions = {}): MarkdownNode[] {
  const out: MarkdownNode[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'text': {
        pushTextNodes(out, token.content, options);
        i += 1;
        break;
      }
      case 'softbreak':
      case 'hardbreak': {
        out.push(options.singleLine ? { type: 'text', text: ' ' } : { type: 'element', tag: 'br', children: [] });
        i += 1;
        break;
      }
      case 'code_inline': {
        out.push({ type: 'element', tag: 'code', children: [{ type: 'text', text: token.content }] });
        i += 1;
        break;
      }
      case 'image': {
        const rawSrc = token.attrGet('src');
        const src = typeof rawSrc === 'string' ? rawSrc : null;
        const label = token.content || src || '';
        if (isSafeLinkHref(src)) {
          out.push({
            type: 'element',
            tag: 'a',
            attrs: { href: src, target: '_blank', rel: 'noopener noreferrer' },
            children: [{ type: 'text', text: label }],
          });
        } else if (label) {
          // Unsafe src: render the alt text only.
          out.push({ type: 'text', text: label });
        }
        i += 1;
        break;
      }
      case 'spoiler_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const children = renderInlineTokens(tokens.slice(i + 1, closeIndex), options);
        out.push({ type: 'element', tag: 'span', attrs: { class: 'spoiler' }, children });
        i = closeIndex + 1;
        break;
      }
      case 'em_open':
      case 'strong_open':
      case 's_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const tag = token.type === 'em_open' ? 'em' : token.type === 'strong_open' ? 'strong' : 's';
        out.push({ type: 'element', tag, children: renderInlineTokens(tokens.slice(i + 1, closeIndex), options) });
        i = closeIndex + 1;
        break;
      }
      case 'link_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const rawHref = token.attrGet('href');
        const href = typeof rawHref === 'string' ? rawHref : null;
        const label = renderInlineTokens(tokens.slice(i + 1, closeIndex), options);
        if (isSafeLinkHref(href)) {
          const custom = options.renderLink?.(href, label, token);
          if (custom != null) {
            out.push(custom);
          } else {
            out.push({
              type: 'element',
              tag: 'a',
              attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
              children: label,
            });
          }
        } else {
          // Downgrade unsafe / relative hrefs to plain text.
          out.push(...label);
        }
        i = closeIndex + 1;
        break;
      }
      case 'html_inline': {
        pushTextNodes(out, token.content, options);
        i += 1;
        break;
      }
      default: {
        if (token.type.endsWith('_open')) {
          // Unknown container: keep its content without a wrapper.
          const closeIndex = findMatchingTokenEnd(tokens, i);
          out.push(...renderInlineTokens(tokens.slice(i + 1, closeIndex), options));
          i = closeIndex + 1;
        } else {
          pushTextNodes(out, token.content, options);
          i += 1;
        }
      }
    }
  }
  return out;
}

function blockInlineContent(inner: readonly Token[], options: MarkdownRenderOptions): MarkdownNode[] {
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

function renderList(tokens: readonly Token[], openIndex: number, options: MarkdownRenderOptions): MarkdownNode {
  const token = tokens[openIndex];
  const closeIndex = findMatchingTokenEnd(tokens, openIndex);
  const items = listItemSlices(tokens.slice(openIndex + 1, closeIndex));
  const tag = token.type === 'ordered_list_open' ? 'ol' : 'ul';
  const ordered = token.type === 'ordered_list_open';

  const attrs: Record<string, string> = {};
  if (ordered) {
    const start = token.attrGet('start');
    const startNumber = start == null ? NaN : Number(start);
    // The default renderer only emits start when it differs from 1.
    if (Number.isInteger(startNumber) && startNumber !== 1) attrs['start'] = String(startNumber);
  }

  return {
    type: 'element',
    tag,
    attrs: Object.keys(attrs).length ? attrs : undefined,
    children: items.map((slice) => ({
      type: 'element',
      tag: 'li',
      children: renderBlocks(slice, options),
    })),
  };
}

function renderBlocks(tokens: readonly Token[], options: MarkdownRenderOptions): MarkdownNode[] {
  const out: MarkdownNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token.type) {
      case 'paragraph_open': {
        const closeIndex = findMatchingTokenEnd(tokens, i);
        const content = blockInlineContent(tokens.slice(i + 1, closeIndex), options);
        // Tight list paragraphs carry hidden: true and must not wrap in <p>.
        if (token.hidden) out.push(...content);
        else out.push({ type: 'element', tag: 'p', children: content });
        i = closeIndex + 1;
        break;
      }
      case 'fence':
      case 'code_block': {
        const language = token.info.trim().split(/\s+/, 1)[0];
        const attrs = language && /^[\w+-]+$/.test(language) ? { class: 'language-' + language } : undefined;
        out.push({
          type: 'element',
          tag: 'pre',
          children: [{ type: 'element', tag: 'code', attrs, children: [{ type: 'text', text: token.content }] }],
        });
        i += 1;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        out.push(renderList(tokens, i, options));
        i = findMatchingTokenEnd(tokens, i) + 1;
        break;
      }
      case 'inline': {
        out.push(...renderInlineTokens(token.children ?? [], options));
        i += 1;
        break;
      }
      default: {
        if (token.type.endsWith('_open')) {
          const closeIndex = findMatchingTokenEnd(tokens, i);
          out.push({
            type: 'element',
            tag: token.tag,
            children: renderBlocks(tokens.slice(i + 1, closeIndex), options),
          });
          i = closeIndex + 1;
        } else {
          pushTextNodes(out, token.content, options);
          i += 1;
        }
      }
    }
  }
  return out;
}

export function renderMarkdownTokens(tokens: readonly Token[], options: MarkdownRenderOptions = {}): MarkdownNode[] {
  return renderBlocks(tokens, options);
}

export function renderMarkdownText(text: string, options: MarkdownRenderOptions = {}): MarkdownNode[] {
  return renderMarkdownTokens(markdownEngine.parse(text, {}), options);
}
