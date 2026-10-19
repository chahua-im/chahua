import { describe, expect, it, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import type { MentionInfo } from '../../../generated/models';

import { MessageText, internalHref, prepareMessageContent } from './message-text';
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

  it('italicizes a mention with spaces inside double underscores', () => {
    const html = toHtml(prepareMessageContent('__ @[uid:7] __', [mention(7, 'Alice')], 7, true).nodes!);
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

  afterEach(() => vi.unstubAllGlobals());

  it('keeps internal links as router targets and external links as new tabs', () => {
    vi.stubGlobal('location', new URL('https://chahua.app'));
    const internal = toHtml(prepareMessageContent('[聊天](https://chahua.app/chats)', [], null, true).nodes!);
    expect(internal).toContain('internal="/chats"');

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
    ['- ```\n  @[uid:7]\n  ```', '@[uid:7]\n'],
    ['```\n```oops\n@[uid:7]\n```', '```oops\n@[uid:7]\n'],
    ['> ```\r\n> @[uid:7]\r\n> ```', '@[uid:7]\n'],
    ['```\n@[uid:7]', '@[uid:7]'],
  ])('keeps code mentions verbatim: %s', (source, content) => {
    const html = toHtml(prepareMessageContent(source + '\n\n**@[uid:7]**', [mention(7, 'Alice')], null, true).nodes!);
    expect(html).toContain(content);
    expect(html).not.toContain('\uFFF0');
    if (source !== '```\n@[uid:7]') expect(html).toContain('@Alice');
  });

  it('does not treat escaped backticks as code delimiters', () => {
    const html = toHtml(prepareMessageContent('\\`@[uid:7]` **ok**', [mention(7, 'Alice')], null, true).nodes!);
    expect(html).toContain('@Alice');
    expect(html).not.toContain('<code>');
  });
});

describe('same-origin navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['https://chahua.app', 'https://other.example', 'http://localhost:4300'])(
    'uses the current origin %s and preserves query and fragment',
    (origin) => {
      vi.stubGlobal('location', new URL(origin));
      expect(internalHref(`${origin}/chats/chat/123?message=456#msg=789`)).toBe('/chats/chat/123?message=456#msg=789');
      for (const path of ['/profile/7', '/m/abc', '/settings', '/stickers/8', '/chats/join/code']) {
        expect(internalHref(origin + path)).toBe(path);
      }
      expect(internalHref(`${origin}/uploads/photo.png`)).toBeUndefined();
      expect(internalHref(`${origin}/_api/chats`)).toBeUndefined();
    },
  );

  it.each([
    'https://chahua.im/chats',
    'https://chahui.app/chats',
    'https://shireyishunjian.com/chats',
    'https://sub.chahua.im/chats',
    'http://chahua.app/chats',
    'https://chahua.app:8443/chats',
  ])('does not route other origins through this app: %s', (url) => {
    vi.stubGlobal('location', new URL('https://chahua.app'));
    expect(internalHref(url)).toBeUndefined();
    const html = toHtml(prepareMessageContent(`[link](${url})`, [], null, true).nodes!);
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('internal=');
  });

  function render(interactive = true) {
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    const f = TestBed.createComponent(MessageText);
    f.componentRef.setInput('text', `[chat](${location.origin}/chats?tab=1#msg=2) [external](https://example.com)`);
    f.componentRef.setInput('interactive', interactive);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    f.detectChanges();
    return { f, navigate, el: f.nativeElement as HTMLElement };
  }

  it('routes an ordinary click using only the app path', () => {
    const { f, el, navigate } = render();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.querySelector('a')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/chats?tab=1#msg=2');
    f.destroy();
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])('preserves native %s clicks', (modifier) => {
    const { f, el, navigate } = render();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
    // Observe the component's decision, then prevent jsdom from attempting real navigation.
    let prevented: boolean | undefined;
    el.querySelector('a')!.addEventListener('click', (e) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    });
    el.querySelector('a')!.dispatchEvent(event);
    expect(prevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(el.querySelector('a')!.getAttribute('href')).toBe(`${location.origin}/chats?tab=1#msg=2`);
    f.destroy();
  });

  it('renders both internal and external preview links without anchors', () => {
    const { f, el, navigate } = render(false);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe('chat external');
    el.querySelector('span')!.click();
    expect(navigate).not.toHaveBeenCalled();
    f.destroy();
  });
});
