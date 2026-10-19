import { describe, expect, it } from 'vitest';
import type { MentionInfo } from '../../../generated/models';

import { prepareMessageContent } from './message-text';
import type { MarkdownNode } from '../../markdown/nodes';

/** Serializes the node tree to HTML so renderer expectations read like markup. */
function toHtml(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'mention':
          return `@${node.name}[self=${node.self} click=${node.clickable}]`;
        case 'widget':
          return toHtml([node.node]);
        default: {
          const attrs = Object.entries(node.attrs ?? {})
            .map(([key, value]) => ` ${key}="${value}"`)
            .join('');
          return `<${node.tag}${attrs}>${toHtml(node.children)}</${node.tag}>`;
        }
      }
    })
    .join('');
}

const mention = (uid: number, username: string): MentionInfo => ({ uid, username, gender: 0 });

describe('prepareMessageContent', () => {
  it('restores mentions nested inside Markdown emphasis', () => {
    const prepared = prepareMessageContent('See **@[uid:7]** now', [mention(7, 'Alice')], 7, true);
    expect(prepared.isMarkdown).toBe(true);
    const html = toHtml(prepared.nodes!);
    expect(html).toContain('<strong>');
    expect(html).toContain('@Alice');
    expect(html.indexOf('@Alice')).toBeGreaterThan(html.indexOf('<strong>'));
  });

  it('italicizes a mention when a stray space precedes the closing star', () => {
    // `*@devuser2 *` was the failing manual-test input: the space on the inner
    // side of the closing star kept the pair literal under CommonMark.
    const html = toHtml(prepareMessageContent('*@[uid:7] *', [mention(7, 'Alice')], 7, true).nodes!);
    expect(html).toContain('<em>');
    expect(html).toContain('@Alice');
  });

  it('keeps mentions inside code verbatim but restores mentions outside', () => {
    const html = toHtml(
      prepareMessageContent('`keep @[uid:8]` and @[uid:9]', [mention(8, 'Bob'), mention(9, 'Carol')], null, true)
        .nodes!,
    );
    expect(html).toContain('<code>keep @[uid:8]</code>');
    expect(html).not.toContain('@Bob');
    expect(html).toContain('@Carol');
  });

  it('does not wrap plain mention-only text as Markdown', () => {
    const prepared = prepareMessageContent('Hi @[uid:7]', [mention(7, 'Alice')], 7, true);
    expect(prepared.isMarkdown).toBe(false);
    expect(prepared.nodes).toBeNull();
  });

  it('marks the current user and only marks mentions clickable when interactive', () => {
    const html = toHtml(prepareMessageContent('**@[uid:7]**', [mention(7, 'Alice')], 7, true).nodes!);
    expect(html).toContain('self=true click=true');

    const inert = toHtml(prepareMessageContent('**@[uid:7]**', [mention(7, 'Alice')], 7, false).nodes!);
    expect(inert).toContain('self=true click=false');

    const other = toHtml(prepareMessageContent('**@[uid:7]**', [mention(7, 'Alice')], 8, true).nodes!);
    expect(other).toContain('self=false');
  });

  it('keeps internal links as router targets and external links as new tabs', () => {
    const internal = toHtml(prepareMessageContent('[聊天](https://chahua.im/chats)', [], null, true).nodes!);
    expect(internal).toContain('internal=""');

    const external = toHtml(prepareMessageContent('[例子](https://example.com/a)', [], null, true).nodes!);
    expect(external).toContain('target="_blank"');
    expect(external).toContain('rel="noopener noreferrer"');
  });

  it('reports block structure only for block-level Markdown', () => {
    expect(prepareMessageContent('**bold** only', [], null, true).hasBlocks).toBe(false);
    expect(prepareMessageContent('- one\n- two', [], null, true).hasBlocks).toBe(true);
    expect(prepareMessageContent('> quoted', [], null, true).hasBlocks).toBe(true);
    // Plain multi-paragraph text carries no markup and stays on the legacy path.
    expect(prepareMessageContent('one\n\ntwo', [], null, true).hasBlocks).toBe(false);
  });
});

describe('code region mention preservation', () => {
  it.each([
    ['`hello\n@[uid:7]`', 'hello @[uid:7]'],
    ['> ```\n> @[uid:7]\n> ```', '@[uid:7]\n'],
    ['- ~~~\n  @[uid:7]\n  ~~~', '@[uid:7]\n'],
    ['```\n```oops\n@[uid:7]\n```', '```oops\n@[uid:7]\n'],
    ['> ~~~\r\n> @[uid:7]\r\n> ~~~', '@[uid:7]\n'],
    ['~~~\n@[uid:7]', '@[uid:7]'],
  ])('keeps code mentions verbatim: %s', (source, content) => {
    const html = toHtml(prepareMessageContent(source + '\n\n**@[uid:7]**', [mention(7, 'Alice')], null, true).nodes!);
    expect(html).toContain(content);
    expect(html).not.toContain('\uFFF0');
    if (!source.startsWith('~~~')) expect(html).toContain('@Alice');
  });

  it('does not treat escaped backticks as code delimiters', () => {
    const html = toHtml(prepareMessageContent('\\`@[uid:7]` **ok**', [mention(7, 'Alice')], null, true).nodes!);
    expect(html).toContain('@Alice');
    expect(html).not.toContain('<code>');
  });
});
