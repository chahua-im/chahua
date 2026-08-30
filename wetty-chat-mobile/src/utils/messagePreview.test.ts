import { describe, expect, it } from 'vitest';
import { formatMessagePreview, formatNotificationBody, getNotificationPreviewLabels } from './messagePreview';

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

describe('formatNotificationBody', () => {
  const preview = { message: 'hello there', messageType: 'text' as const };

  it('renders generic copy for plain messages', () => {
    expect(formatNotificationBody('alice', preview, labels, 'message')).toBe('alice: hello there');
    expect(formatNotificationBody('alice', null, labels, 'message')).toBe('alice sent a message');
  });

  it('renders mention copy for mentions', () => {
    expect(formatNotificationBody('alice', preview, labels, 'mention')).toBe('alice mentioned you: hello there');
    expect(formatNotificationBody('alice', null, labels, 'mention')).toBe('alice mentioned you');
  });

  it('renders reply copy for replies', () => {
    expect(formatNotificationBody('alice', preview, labels, 'reply')).toBe('alice replied to you: hello there');
    expect(formatNotificationBody('alice', null, labels, 'reply')).toBe('alice replied to you');
  });

  it('localizes reply copy for zh-CN and zh-TW', () => {
    const zhCN = getNotificationPreviewLabels('zh-CN');
    const zhTW = getNotificationPreviewLabels('zh-TW');
    expect(formatNotificationBody('小明', preview, zhCN, 'reply')).toBe('小明 回复了你: hello there');
    expect(formatNotificationBody('小明', preview, zhTW, 'reply')).toBe('小明 回覆了你: hello there');
  });
});
