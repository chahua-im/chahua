import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import bubbleStyles from './ChatBubble.module.scss';
import { ChatBubbleBase, type ChatBubbleBaseProps } from './ChatBubbleBase';

vi.mock('react-redux', () => ({
  useSelector: (selector: (state: unknown) => unknown) => selector(undefined),
}));

vi.mock('@/store/settingsSlice', () => ({
  selectChatFontSizeStyle: () => '14px',
}));

vi.mock('@/hooks/platformHooks', () => ({
  useIsDarkMode: () => false,
  useMouseDetected: () => false,
}));

vi.mock('@ionic/react', () => ({
  IonIcon: () => null,
  isPlatform: () => false,
}));

vi.mock('@lingui/core/macro', () => ({
  t: (strings: TemplateStringsArray | string) => (Array.isArray(strings) ? strings.join('') : strings),
}));

vi.mock('./VoiceMessageBubble', () => ({
  VoiceMessageBubble: () => null,
}));

function renderBubble(overrides: Partial<ChatBubbleBaseProps>): string {
  return renderToStaticMarkup(
    createElement(ChatBubbleBase, {
      message: '',
      senderName: 'Alice',
      isSent: false,
      layout: 'bubble-only',
      showName: false,
      showAvatar: false,
      mentions: [],
      currentUserUid: null,
      ...overrides,
    }),
  );
}

describe('ChatBubbleBase — Markdown bodies', () => {
  it('renders block-level Markdown in a block container without width measurement', () => {
    const html = renderBubble({ message: '# Title\n\nline two **bold**' });

    expect(html).toContain(bubbleStyles.markdownBody);
    expect(html).toContain(bubbleStyles.markdownBlocks);
    // Headings are out of the subset: '# Title' renders as literal paragraph text.
    expect(html).toContain('<p># Title</p>');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<strong>bold</strong>');
    // Character-width layout only applies to legacy text bodies.
    expect(html).not.toContain('style="width:');
  });

  it('keeps plain-text messages on the legacy body path', () => {
    const html = renderBubble({ message: 'Hello there' });

    expect(html).toContain(bubbleStyles.messageText);
    expect(html).not.toContain(bubbleStyles.markdownBody);
    expect(html).not.toContain('<p>');
  });
});
