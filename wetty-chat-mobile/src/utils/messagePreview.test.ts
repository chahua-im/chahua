import { describe, expect, it } from 'vitest';
import { formatMessagePreview, getNotificationPreviewLabels } from './messagePreview';

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
