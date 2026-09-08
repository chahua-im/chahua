import { Fragment, createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildPlaceholder } from './placeholder';
import { renderMarkdownPreview } from './preview';
import { renderMarkdownText } from './react-renderer';
import type { MarkdownRenderOptions } from './react-renderer';

function staticMarkup(nodes: ReactNode[]): string {
  return renderToStaticMarkup(createElement(Fragment, null, nodes));
}

function renderText(markdown: string, options?: MarkdownRenderOptions): string {
  return staticMarkup(renderMarkdownText(markdown, options));
}

describe('renderMarkdownText — inline', () => {
  it('renders bold, italic, strikethrough and inline code', () => {
    expect(renderText('**bold** *italic* ~~strike~~ `code`')).toContain(
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
    expect(renderText('**bold and *nested***')).toContain('<strong>bold and <em>nested</em></strong>');
  });

  it('does not parse markers inside inline code', () => {
    expect(renderText('`**x**`')).toBe('<p><code>**x**</code></p>');
  });

  it('escapes raw HTML instead of executing it', () => {
    expect(renderText('<em>x</em>')).toBe('<p>&lt;em&gt;x&lt;/em&gt;</p>');
    expect(renderText('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('keeps single newlines inside a paragraph', () => {
    expect(renderText('line one\nline two')).toBe('<p>line one\nline two</p>');
  });
});

describe('renderMarkdownText — links and images', () => {
  it('renders explicit links with safe target and rel', () => {
    const html = renderText('[example](https://example.com/path?q=1)');
    expect(html).toContain('<a href="https://example.com/path?q=1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>example</a>');
  });

  it('renders linkified bare URLs as links', () => {
    expect(renderText('visit https://example.com/x today')).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>',
    );
  });

  it('downgrades javascript: and relative hrefs to plain label text', () => {
    // javascript: is rejected by the parser itself and stays literal text…
    const js = renderText('[x](javascript:alert(1))');
    expect(js).not.toContain('<a');
    expect(js).not.toContain('href');
    // …while non-http(s) schemes pass parsing but lose the anchor here.
    expect(renderText('[mail](mailto:a@b.com)')).toBe('<p>mail</p>');
    expect(renderText('[local](/m/abc)')).toBe('<p>local</p>');
  });

  it('shows image macros as literal text instead of <img>', () => {
    // Image syntax is out of the allowlist, so the macro stays visible verbatim.
    const html = renderText('![diagram](diagram.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('![diagram](diagram.png)');
  });

  it('keeps unsafe image sources as literal text', () => {
    // `javascript:` is rejected by the parser, so the whole construct stays text.
    const html = renderText('![alt](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('<img');
    expect(html).toBe('<p>![alt](javascript:alert(1))</p>');
  });

  it('invokes renderLink hook for custom anchors', () => {
    const html = renderText('[inv](https://inv.example/x)', {
      renderLink: (href, label) => createElement('span', { className: 'card', 'data-href': href }, label),
    });
    expect(html).toContain('<span class="card" data-href="https://inv.example/x">inv</span>');
  });
});

describe('renderMarkdownText — placeholders', () => {
  it('restores placeholders at their original positions', () => {
    const text = `Hi ${buildPlaceholder(0)} and **bold** after ${buildPlaceholder(1)}!`;
    const html = renderText(text, {
      onPlaceholder: (index) => createElement('span', { className: 'mention' }, index === 0 ? '@alice' : '@bob'),
    });
    expect(html).toBe(
      '<p>Hi <span class="mention">@alice</span> and <strong>bold</strong> after <span class="mention">@bob</span>!</p>',
    );
  });

  it('drops placeholders when no restore hook is provided', () => {
    expect(renderText(`a${buildPlaceholder(2)}b`)).toBe('<p>ab</p>');
  });

  it('restores placeholders nested inside emphasis', () => {
    const html = renderText(`**hi ${buildPlaceholder(0)}**`, {
      onPlaceholder: () => '@alice',
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
    expect(staticMarkup(renderMarkdownPreview('**bold** and `code`'))).toBe(
      '<strong>bold</strong> and <code>code</code>',
    );
  });

  it('collapses line breaks to spaces', () => {
    expect(staticMarkup(renderMarkdownPreview('l1\nl2'))).toBe('l1 l2');
  });

  it('keeps headings literal on one line', () => {
    expect(staticMarkup(renderMarkdownPreview('# Title\n\nBody'))).toBe('# Title Body');
  });

  it('flattens lists with bullets and order markers', () => {
    expect(staticMarkup(renderMarkdownPreview('- one\n- two'))).toBe('• one • two');
    expect(staticMarkup(renderMarkdownPreview('3. three\n4. four'))).toBe('3. three 4. four');
  });

  it('flattens blockquotes and code blocks', () => {
    expect(staticMarkup(renderMarkdownPreview('> quoted\n\nrest'))).toBe('quoted rest');
    expect(staticMarkup(renderMarkdownPreview('```\na\nb\n```'))).toBe('<code>a b</code>');
  });

  it('drops empty output but keeps rule text literal', () => {
    expect(staticMarkup(renderMarkdownPreview(''))).toBe('');
    expect(staticMarkup(renderMarkdownPreview('---'))).toBe('---');
  });

  it('restores placeholders in previews too', () => {
    const nodes = renderMarkdownPreview(`see ${buildPlaceholder(0)} now`, {
      onPlaceholder: () => '@alice',
    });
    expect(renderToStaticMarkup(createElement(Fragment, null, nodes))).toBe('see @alice now');
  });
});
