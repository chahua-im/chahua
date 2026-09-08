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
    expect(markdownEngine.render('* item\n**bold**', {}).trim()).toBe(
      '<p>* item<br>\n<strong>bold</strong></p>',
    );
  });

  it('keeps dash and ordered lists working', () => {
    const dash = markdownEngine.render('- a\n- b', {}).trim();
    expect(dash.startsWith('<ul>')).toBe(true);
    expect(dash).toContain('<li>a</li>');
    expect(dash).toContain('<li>b</li>');
  });
});

describe('single-asterisk italic space-adaptation', () => {
  it('forgives a single stray space inside a mention star pair', () => {
    // `*@devuser2 *` was the failing manual-test input: the space on the inner
    // side of the closing `*` kept the pair literal under CommonMark.
    expect(markdownEngine.render('*@devuser2 *', {}).trim()).toContain('<em>@devuser2</em>');
    expect(markdownEngine.render('* @devuser2*', {}).trim()).toContain('<em>@devuser2</em>');
  });

  it('forgives only one stray space, not symmetric spacing', () => {
    expect(markdownEngine.render('*italic words here *', {}).trim()).toContain(
      '<em>italic words here</em>',
    );
    expect(markdownEngine.render('* x *', {}).trim()).toBe('<p>* x *</p>');
  });

  it('keeps arithmetic-like symmetric `5 * 3 * 4` literal', () => {
    expect(markdownEngine.render('5 * 3 * 4', {}).trim()).toBe('<p>5 * 3 * 4</p>');
    expect(markdownEngine.render('a *2 * b', {}).trim()).toBe('<p>a *2 * b</p>');
  });

  it('never touches stars inside code spans', () => {
    expect(markdownEngine.render('`*a *`', {}).trim()).toBe('<p><code>*a *</code></p>');
  });
});
