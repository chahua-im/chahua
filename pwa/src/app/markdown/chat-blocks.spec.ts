import { describe, expect, it } from 'vitest';
import { markdownEngine } from './engine';
import { extractMentionWidgets } from './mentions';
import { renderMarkdownText, type MarkdownNode } from './nodes';
import { renderMarkdownPreview } from './preview';

function plainText(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node): string => {
      if (node.type === 'text') return node.text;
      if (node.type === 'widget') return plainText([node.node]);
      if (node.type === 'mention') return '@' + node.name;
      return node.tag === 'br' ? '\n' : plainText(node.children);
    })
    .join('');
}

describe('chat text and structural boundaries', () => {
  it.each(['\n', '\r\n', '\r'])('preserves every newline and neighboring space with %j line endings', (newline) => {
    const source = ['  **甲**  ', '  乙', '', ' \t', '丙\\', '  丁', ''].join(newline);
    const expected = ['  甲  ', '  乙', '', ' \t', '丙\\', '  丁', ''].join('\n');
    expect(plainText(renderMarkdownText(source))).toBe(expected);
    expect(plainText(renderMarkdownPreview(source))).toBe(expected.replace(/\n/g, ' '));
  });

  it.each([
    ['**', 'strong'],
    ['__', 'em'],
    ['~~', 's'],
    ['||', 'span'],
  ])('lets %s formatting span blank lines', (marker, tag) => {
    const source = `${marker}甲\n\n\n乙${marker}`;
    const nodes = renderMarkdownText(source);
    expect(plainText(nodes)).toBe('甲\n\n\n乙');
    expect(nodes).toMatchObject([{ tag: 'p', children: [{ tag, children: expect.any(Array) }] }]);
    expect(plainText(renderMarkdownPreview(source))).toBe('甲   乙');
  });

  it('does not change blank lines when a URL is added', () => {
    const source = '甲\n\n\nhttps://example.com\n\n乙';
    expect(plainText(renderMarkdownText(source))).toBe(source);
  });

  it('keeps leading and trailing blank lines in an ordinary text region', () => {
    expect(plainText(renderMarkdownText('\n\n**甲**\n\n'))).toBe('\n\n甲\n\n');
  });

  it('preserves list continuation lines and blanks within the same item', () => {
    const source = '- **甲\n  \n  乙**\n- 丙';
    const html = markdownEngine.render(source);
    expect(html).toContain('<strong>甲<br>\n<br>\n乙</strong>');
    expect(html).toContain('<li>丙</li>');
  });

  it('preserves the exact blank row count between items and around nested lists and fences', () => {
    const source = '前文\n\n- 甲\n\n\n  - 子项\n\n- 乙\n\n```ts\nconst x = 1;\n```\n\n后文';
    const html = markdownEngine.render(source);
    expect(html.match(/class="chat-line-gap"/g)).toHaveLength(5);
    expect(html).toContain('<div class="chat-line-gap"><br><br></div>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code class="language-ts">const x = 1;\n</code>');
    expect(plainText(renderMarkdownPreview(source))).toBe('前文  • 甲   • 子项  • 乙  const x = 1;  后文');
  });

  it.each(['- **甲\n- 乙**', '**甲\n- 乙**', '- **甲\n\n乙**', '**甲\n```\n代码\n```\n乙**'])(
    'does not match formatting across a structural boundary: %s',
    (source) => {
      expect(markdownEngine.render(source)).not.toContain('<strong>');
    },
  );

  it('keeps fences verbatim, including syntax and mentions inside them', () => {
    const code = '  **甲**\n\n- 乙\n1. 丙\n@[uid:2]\n';
    const source = '```text\n' + code + '```';
    expect(plainText(renderMarkdownText(source))).toBe(code);
    expect(extractMentionWidgets(source)).toEqual({ body: source, widgets: [] });
  });

  it('preserves multiline inline code and uses the same boundaries for mentions', () => {
    const source = '`甲\n\n@[uid:2]`\n\n@[uid:3]';
    expect(plainText(renderMarkdownText(source))).toBe('甲\n\n@[uid:2]\n\n@[uid:3]');
    const extracted = extractMentionWidgets(source);
    expect(extracted.body).toContain('`甲\n\n@[uid:2]`');
    expect(extracted.widgets).toEqual([{ uid: 3 }]);
    expect(plainText(renderMarkdownPreview(source))).toBe('甲  @[uid:2]  @[uid:3]');
  });

  it('does not overwrite an earlier code span when later backticks are unmatched', () => {
    expect(plainText(renderMarkdownText('`first` then `unclosed'))).toBe('first then `unclosed');
  });
});
