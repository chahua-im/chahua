import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { renderMessageContent } from './messageContent';

vi.mock('./InviteLinkInline', () => ({
  InviteLinkInline: ({ url }: { url: string }) => <span data-kind="invite">{url}</span>,
}));

vi.mock('./PermalinkInline', () => ({
  PermalinkInline: ({ url }: { url: string }) => <span data-kind="permalink">{url}</span>,
}));

vi.mock('@/utils/inviteUrl', () => ({
  parseInviteCodeFromUrl: (url: string) => (url.includes('/invite/') ? 'invite-code' : null),
}));

vi.mock('@/utils/permalinkUrl', () => ({
  decodePermalink: () => ({ chatId: 'chat-1', messageId: 'msg-1' }),
}));

describe('renderMessageContent', () => {
  it('renders links and mentions from message text', () => {
    const html = renderToStaticMarkup(
      <>
        {renderMessageContent(
          'Hello @[uid:7] https://example.test/path.',
          [{ uid: 7, username: 'Alice', gender: 0 }],
          7,
          vi.fn(),
        )}
      </>,
    );

    expect(html).toContain('@Alice');
    expect(html).toContain('https://example.test/path');
    expect(html).toContain('href="https://example.test/path"');
  });

  it('uses specialized inline components for invite and permalink URLs', () => {
    const permalinkUrl = `${document.location.origin}/m/abc123`;
    const html = renderToStaticMarkup(
      <>{renderMessageContent(`Join https://example.test/invite/abc or ${permalinkUrl}`, [], null, undefined)}</>,
    );

    expect(html).toContain('data-kind="invite"');
    expect(html).toContain('data-kind="permalink"');
  });
});

describe('renderMessageContent — Markdown support', () => {
  const render = (message: string, mentions: { uid: number; username: string; gender: number }[] = []) =>
    renderToStaticMarkup(
      <>{renderMessageContent(message, mentions, mentions[0]?.uid ?? null, mentions.length ? vi.fn() : undefined)}</>,
    );

  it('restores mentions nested inside Markdown emphasis', () => {
    const html = render('See **@[uid:7]** now', [{ uid: 7, username: 'Alice', gender: 0 }]);
    expect(html).toContain('@Alice');
    expect(html).toContain('<strong>');
    expect(html.indexOf('@Alice')).toBeGreaterThan(html.indexOf('<strong>'));
  });

  it('italicizes a mention when a stray space precedes the closing `*`', () => {
    // `*@devuser2 *` was the failing manual-test input: the space on the inner
    // side of the closing star kept the pair literal under CommonMark.
    const html = render('*@[uid:7] *', [{ uid: 7, username: 'Alice', gender: 0 }]);
    expect(html).toContain('<em>');
    expect(html).toContain('@Alice');
    expect(html.indexOf('@Alice')).toBeGreaterThan(html.indexOf('<em>'));
  });

  it('keeps mentions inside code verbatim but restores mentions outside', () => {
    const html = render('`keep @[uid:8]` and @[uid:9]', [
      { uid: 8, username: 'Bob', gender: 0 },
      { uid: 9, username: 'Carol', gender: 0 },
    ]);
    expect(html).toContain('<code>keep @[uid:8]</code>');
    expect(html).not.toContain('@Bob');
    expect(html).toContain('@Carol');
  });

  it('does not wrap plain mention-only text as Markdown', () => {
    const html = render('Hi @[uid:7]', [{ uid: 7, username: 'Alice', gender: 0 }]);
    expect(html).toContain('@Alice');
    expect(html).not.toContain('<p>');
  });

  it('renders invite widget for autolinked invite URL and keeps explicit links as anchors', () => {
    const html = render('join https://example.test/invite/abc today');
    expect(html).toContain('data-kind="invite"');

    const explicit = render('[join](https://example.test/invite/abc)');
    expect(explicit).toContain('>join</a>');
    expect(explicit).toContain('href="https://example.test/invite/abc"');
  });
});
