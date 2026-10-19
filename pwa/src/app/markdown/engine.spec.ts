import { describe, expect, it } from 'vitest';

import { createMarkdownEngine, markdownEngine } from './engine';

describe('markdown engine configuration', () => {
  it('keeps raw HTML inert by default (html:false)', () => {
    expect(markdownEngine.render('<script>alert(1)</script>', {})).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n',
    );
  });

  it('supports strikethrough out of the box (default preset)', () => {
    expect(markdownEngine.render('~~gone~~', {}).trim()).toBe('<p><s>gone</s></p>');
  });

  it('does not treat single tildes as markup', () => {
    expect(markdownEngine.render('a ~2~ b', {}).trim()).toBe('<p>a ~2~ b</p>');
  });

  it('breaks single newlines into hard line breaks (breaks:true)', () => {
    expect(markdownEngine.render('a\nb', {}).trim()).toBe('<p>a<br>\nb</p>');
  });

  it('never turns javascript: URLs into links', () => {
    expect(markdownEngine.render('[x](javascript:alert(1))', {}).trim()).toBe('<p>[x](javascript:alert(1))</p>');
  });

  it('linkifies bare URLs with trailing markup normalized', () => {
    expect(markdownEngine.render('see http://example.com/x?y=1 now', {}).trim()).toBe(
      '<p>see <a href="http://example.com/x?y=1">http://example.com/x?y=1</a> now</p>',
    );
  });

  it('keeps raw HTML inert even when html is requested (out of subset)', () => {
    // HTML rules are disabled by the subset regardless of the `html` option,
    // so an instance created with html:true still cannot execute tags.
    const md = createMarkdownEngine({ html: true });
    expect(md.render('<b>x</b>', {}).trim()).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });
});

describe('`*` is not a list marker', () => {
  it('keeps star-bullet lines as text instead of a list', () => {
    expect(markdownEngine.render('* item', {}).trim()).toBe('<p>* item</p>');
    expect(markdownEngine.render('* item\n* two', {}).trim()).toBe('<p>* item<br>\n* two</p>');
  });

  it('still allows emphasis right after a literal star line', () => {
    expect(markdownEngine.render('* item\n**bold**', {}).trim()).toBe('<p>* item<br>\n<strong>bold</strong></p>');
  });

  it('keeps dash and ordered lists working', () => {
    const dash = markdownEngine.render('- a\n- b', {}).trim();
    expect(dash.startsWith('<ul>')).toBe(true);
    expect(dash).toContain('<li>a</li>');
    expect(dash).toContain('<li>b</li>');
  });
});

describe('formatting syntax', () => {
  it.each(['*italic*', '***bold italic***', 'a * word * b', '*word *', '* word*'])(
    'keeps unsupported star syntax literal: %s',
    (text) => {
      expect(markdownEngine.render(text).trim()).toBe(`<p>${text}</p>`);
    },
  );

  it.each([
    ['**bold**', '<strong>bold</strong>'],
    ['__italic__', '<em>italic</em>'],
    ['**__both__**', '<strong><em>both</em></strong>'],
    ['__**both**__', '<em><strong>both</strong></em>'],
    ['**bold __nested__ end**', '<strong>bold <em>nested</em> end</strong>'],
    ['__italic **nested** end__', '<em>italic <strong>nested</strong> end</em>'],
  ])('renders supported formatting: %s', (text, html) => {
    expect(markdownEngine.render(text).trim()).toBe(`<p>${html}</p>`);
  });

  it.each(['**', '__', '~~'])('moves inner whitespace outside %s pairs', (marker) => {
    const tag = marker === '**' ? 'strong' : marker === '__' ? 'em' : 's';
    expect(markdownEngine.render(`a ${marker} hello ${marker} b`).trim()).toBe(`<p>a  <${tag}>hello</${tag}>  b</p>`);
  });

  it.each(['~~~\nplain\n~~~', '> ~~~\n> plain\n> ~~~', '- ~~~\n  plain\n  ~~~'])(
    'does not treat tildes as a code fence: %s',
    (source) => {
      const html = markdownEngine.render(source);
      expect(html).not.toContain('<pre>');
      expect(html).not.toContain('<code>');
      expect(html).toContain('plain');
    },
  );

  it('preserves literal markers inside backtick code', () => {
    expect(markdownEngine.render('`** x ** __ y __ *z*`')).toContain('<code>** x ** __ y __ *z*</code>');
  });
});

describe('normalization boundaries', () => {
  it('does not pair different marker types', () => {
    expect(markdownEngine.render('** bold ~~').trim()).toBe('<p>** bold ~~</p>');
    expect(markdownEngine.render('~~ gone __').trim()).toBe('<p>~~ gone __</p>');
  });

  it('reflows nested pairs without changing their marker types', () => {
    expect(markdownEngine.render('** bold __italic__ end **').trim()).toBe(
      '<p><strong>bold <em>italic</em> end</strong></p>',
    );
    expect(markdownEngine.render('** bold __ italic __ end **').trim()).toBe(
      '<p><strong>bold  <em>italic</em>  end</strong></p>',
    );
  });

  it('does not let an unmatched marker on a previous line consume a pair', () => {
    expect(markdownEngine.render('** unmatched\n** bold **')).toContain('<strong>bold</strong>');
  });

  it.each(['- ```\n  ** x **\n  ```'])('preserves nested code content: %s', (source) => {
    expect(markdownEngine.render(source)).toContain('<code>** x **\n</code>');
  });

  it('keeps image syntax and formatting literal inside nested fences', () => {
    expect(markdownEngine.render('- ```\n  ![x](url) __ x __\n  ```')).toContain('<code>![x](url) __ x __\n</code>');
  });
});
