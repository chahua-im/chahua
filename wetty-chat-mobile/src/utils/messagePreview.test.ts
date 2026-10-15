import { describe, expect, it } from 'vitest';
import { formatMessagePreview, getNotificationPreviewLabels, truncatePreview } from './messagePreview';

const labels = getNotificationPreviewLabels('en');

describe('formatMessagePreview', () => {
  it('uses the generic attachment label for file messages regardless of MIME or text', () => {
    expect(
      formatMessagePreview({ messageType: 'file', message: 'caption', attachments: [{ kind: 'audio/mpeg' }] }, labels),
    ).toBe('[Attachment]');
    expect(formatMessagePreview({ messageType: 'file', attachments: [{ kind: 'image/png' }] }, labels)).toBe(
      '[Attachment]',
    );
  });

  it('reserves voice previews for microphone audio messages', () => {
    expect(formatMessagePreview({ messageType: 'audio', attachments: [{ kind: 'audio/mpeg' }] }, labels)).toBe(
      '[Voice message]',
    );
  });
});

describe('truncatePreview', () => {
  it('leaves short text untouched', () => {
    expect(truncatePreview('hello', 10)).toBe('hello');
    expect(truncatePreview('hello', 5)).toBe('hello');
  });

  it('replaces the last character with an ellipsis and stays within maxLength', () => {
    expect(truncatePreview('abcdefghij', 5)).toBe('abcd…');
    expect(truncatePreview('abcdefghij', 5)).toHaveLength(5);
  });

  it('defaults to MESSAGE_PREVIEW_MAX', () => {
    const text = 'x'.repeat(150);
    expect(truncatePreview(text)).toHaveLength(100);
    expect(truncatePreview(text).endsWith('…')).toBe(true);
  });
});
