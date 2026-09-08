import { describe, expect, it } from 'vitest';

import { buildPlaceholder } from './placeholder';
import { renderMarkdownPreview } from './preview';
import { renderMarkdownText } from './nodes';
import type { MarkdownNode, MarkdownRenderOptions } from './nodes';

/** Serializes the node tree to HTML so renderer expectations read like markup. */
function toHtml(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        case 'mention':
          return `<${node.clickable ? 'button' : 'span'} class="mention">@${node.name}</${node.clickable ? 'button' : 'span'}>`;
        case 'widget':
          return toHtml([node.node]);
        default: {
          const attrs = Object.entries(node.attrs ?? {})
            .map(([key, value]) => ` ${key}="${value}"`)
            .join('');
          const tag = node.tag;
          if (!node.children.length && (node.tag === 'br' || node.tag === 'hr')) return `<${tag}${attrs}>`;
          return `<${tag}${attrs}>${toHtml(node.children)}</${tag}>`;
        }
      }
    })
    .join('');
}

function renderText(markdown: string, options?: MarkdownRenderOptions): string {
  return toHtml(renderMarkdownText(markdown, options));
}

function renderPreview(markdown: string, options?: MarkdownRenderOptions): string {
  return toHtml(renderMarkdownPreview(markdown, options));
}

describe('renderMarkdownText — inline', () => {
  it('renders bold, italic, strikethrough and inline code', () => {
    expect(renderText('**bold** *italic* ~~strike~~ `code`')).toBe(
      '<p><strong>bold</strong> <em>italic</em> <s>strike</s> <code>code</code></p>',
    );
  });

  it('renders underline from double underscores', () => {
    expect(renderText('__under__')).toBe('<p><u>under</u></p>');
    expect(renderText('__a__ and **b**')).toBe('<p><u>a</u> and <strong>b</strong></p>');
  });

  it('renders single underscore markers as literal text', () => {
    expect(renderText('_literal_ and __under__')).toBe('<p>_literal_ and <u>under</u></p>');
  });

  it('renders nested emphasis', () => {
    expect(renderText('**bold and *nested***')).toBe('<p><strong>bold and <em>nested</em></strong></p>');
  });

  it('does not parse markers inside inline code', () => {
    expect(renderText('`**x**`')).toBe('<p><code>**x**</code></p>');
  });

  it('escapes raw HTML instead of executing it', () => {
    expect(renderText('<em>x</em>')).toBe('<p>&lt;em&gt;x&lt;/em&gt;</p>');
  });

  it('keeps single newlines inside a paragraph as <br>', () => {
    expect(renderText('line one\nline two')).toBe('<p>line one<br>line two</p>');
  });
});

describe('renderMarkdownText — links and images', () => {
  it('renders explicit links with safe target and rel', () => {
    const html = renderText('[example](https://example.com/path?q=1)');
    expect(html).toBe('<p><a href="https://example.com/path?q=1" target="_blank" rel="noopener noreferrer">example</a></p>');
  });

  it('renders linkified bare URLs as links', () => {
    expect(renderText('visit https://example.com/x today')).toBe(
      '<p>visit <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a> today</p>',
    );
  });

  it('downgrades javascript: and relative hrefs to plain label text', () => {
    // javascript: is rejected by the parser itself and stays literal text…
    const js = renderText('[x](javascript:alert(1))');
    expect(js).toBe('<p>[x](javascript:alert(1))</p>');
    // …while non-http(s) schemes pass parsing but lose the anchor here.
    expect(renderText('[mail](mailto:a@b.com)')).toBe('<p>mail</p>');
    expect(renderText('[local](/m/abc)')).toBe('<p>local</p>');
  });

  it('shows image macros as literal text instead of <img>', () => {
    // Image syntax is out of the allowlist, so the macro stays visible verbatim.
    const html = renderText('![diagram](diagram.png)');
    expect(html).toBe('<p>![diagram](diagram.png)</p>');
  });

  it('invokes renderLink hook for custom anchors', () => {
    const html = renderText('[inv](https://inv.example/x)', {
      renderLink: (href, label) => ({ type: 'element', tag: 'span', attrs: { 'data-href': href }, children: label }),
    });
    expect(html).toBe('<p><span data-href="https://inv.example/x">inv</span></p>');
  });
});

describe('renderMarkdownText — placeholders', () => {
  it('restores placeholders at their original positions', () => {
    const text = `Hi ${buildPlaceholder(0)} and **bold** after ${buildPlaceholder(1)}!`;
    const html = renderText(text, {
      onPlaceholder: (index) => ({ type: 'text', text: index === 0 ? '@alice' : '@bob' }),
    });
    expect(html).toBe('<p>Hi @alice and <strong>bold</strong> after @bob!</p>');
  });

  it('drops placeholders when no restore hook is provided', () => {
    expect(renderText(`a${buildPlaceholder(2)}b`)).toBe('<p>ab</p>');
  });

  it('restores placeholders nested inside emphasis', () => {
    const html = renderText(`**hi ${buildPlaceholder(0)}**`, {
      onPlaceholder: () => ({ type: 'text', text: '@alice' }),
    });
    expect(html).toBe('<p><strong>hi @alice</strong></p>');
  });
});

describe('renderMarkdownText — blocks', () => {
  it('renders supported blocks and keeps headings and hr literal', () => {
    const html = renderText('# Title\n\n> Quote **bold**\n\n- a\n- b\n\n---\n');
    // Heading and horizontal-rule syntax are out of the allowlist.
    expect(html).toContain('<p># Title</p>');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<blockquote><p>Quote <strong>bold</strong></p></blockquote>');
    // Tight lists must not wrap items in <p>.
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).not.toContain('<hr');
    expect(html).toContain('<p>---</p>');
  });

  it('renders ordered lists and keeps an explicit start attribute', () => {
    expect(renderText('3. three\n4. four')).toContain('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(renderText('1. one\n2. two')).toContain('<ol><li>one</li><li>two</li></ol>');
  });

  it('renders nested lists', () => {
    const html = renderText('- a\n  - nested\n- b');
    expect(html).toContain('<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>');
  });

  it('renders fenced code with a sanitized language class', () => {
    const html = renderText('```ts\nconst a = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">const a = 1;');
    expect(html).toContain('</code></pre>');
  });

  it('escapes code fence content and drops unsafe language classes', () => {
    const html = renderText('```"><img onerror=1>\n<b>raw</b>\n```');
    expect(html).not.toContain('language-');
    expect(html).not.toContain('<b>raw</b>');
    expect(html).toContain('&lt;b&gt;raw&lt;/b&gt;');
  });

  it('treats indented code as literal paragraph text', () => {
    const html = renderText('    indented code');
    expect(html).not.toContain('<pre>');
    expect(html).toContain('indented code');
  });

  it('wraps loose list items in paragraphs', () => {
    const html = renderText('- first\n\n- second');
    expect(html).toContain('<li><p>first</p></li>');
  });

  it('renders multiple paragraphs separately', () => {
    expect(renderText('one\n\ntwo')).toBe('<p>one</p><p>two</p>');
  });
});

describe('renderMarkdownPreview — single line', () => {
  it('flattens inline formatting onto one line', () => {
    expect(renderPreview('**bold** and `code`')).toBe('<strong>bold</strong> and <code>code</code>');
  });

  it('collapses line breaks to spaces', () => {
    expect(renderPreview('l1\nl2')).toBe('l1 l2');
  });

  it('keeps headings literal on one line', () => {
    expect(renderPreview('# Title\n\nBody')).toBe('# Title Body');
  });

  it('flattens lists with bullets and order markers', () => {
    expect(renderPreview('- one\n- two')).toBe('• one • two');
    expect(renderPreview('3. three\n4. four')).toBe('3. three 4. four');
  });

  it('flattens blockquotes and code blocks', () => {
    expect(renderPreview('> quoted\n\nrest')).toBe('quoted rest');
    expect(renderPreview('```\na\nb\n```')).toBe('<code>a b</code>');
  });

  it('drops empty output but keeps rule text literal', () => {
    expect(renderPreview('')).toBe('');
    expect(renderPreview('---')).toBe('---');
  });

  it('restores placeholders in previews too', () => {
    const html = renderPreview(`see ${buildPlaceholder(0)} now`, {
      onPlaceholder: () => ({ type: 'text', text: '@alice' }),
    });
    expect(html).toBe('see @alice now');
  });
});
