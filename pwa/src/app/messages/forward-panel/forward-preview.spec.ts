import { LinkPreviewStatus, MessageType } from '../../../generated/models';
import { testMessage } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { buildForwardPreview } from './forward-preview';

describe('client forward preview', () => {
  const author = { ...testMessage.sender, uid: 2, name: 'original' };
  const source = { ...testMessage, sender: author };
  const reply = { ...source, mentions: [] };

  it('preserves the origin, topic count and ready links on a single forward', () => {
    const origin = {
      sender: author,
      originalChatId: source.chatId,
      originalMessageId: source.id,
      originalReplyTo: reply,
    };
    const ready = { url: 'https://example.org/', status: LinkPreviewStatus.ready };
    const metadata = { linkPreviews: [ready, { ...ready, status: LinkPreviewStatus.pending }] };
    const preview = buildForwardPreview([
      { ...source, metadata, forwardedFrom: origin, threadInfo: { replyCount: 10 }, forwardedThreadReplyCount: 2 },
    ]);
    expect(preview.message.forwardedFrom).toEqual(origin);
    expect(preview.message.forwardedThreadReplyCount).toBe(2);
    expect(preview.message.threadInfo).toBeUndefined();
    expect(preview.message.metadata?.linkPreviews).toEqual([ready]);
  });

  it('uses a static placeholder for invitation quotes in single forwards and re-forwards', () => {
    const invite = { ...reply, messageType: MessageType.invite, message: 'fixture code' };
    const quoted = { ...source, replyToMessage: invite };
    const reforwarded = {
      ...source,
      forwardedFrom: {
        sender: author,
        originalChatId: source.chatId,
        originalMessageId: source.id,
        originalReplyTo: invite,
      },
    };
    for (const message of [quoted, reforwarded]) {
      expect(buildForwardPreview([message]).message.forwardedFrom?.originalReplyTo).toMatchObject({
        messageType: MessageType.placeholder,
        message: 'groupInvite',
      });
    }
  });

  it('builds ordered summaries and quotes from the same sanitized local records', () => {
    const invite = { ...source, id: encodeId('1'), messageType: MessageType.invite, message: 'private invite' };
    const pending = {
      ...source,
      id: encodeId('2'),
      replyToMessage: { ...invite, mentions: [] },
      audioPending: true,
      messageType: MessageType.audio,
    };
    const third = { ...source, id: encodeId('3'), replyToMessage: reply, threadInfo: { replyCount: 4 } };
    const preview = buildForwardPreview([third, pending, invite, { ...source, id: encodeId('4') }]);
    expect(preview.message.forwardedBundleId).toBeUndefined();
    expect(preview.message.forwardedPreview?.messages.map((item) => item.message)).toEqual([
      'groupInvite',
      'pendingAudio',
      third.message,
    ]);
    expect(preview.message.forwardedPreview?.total).toBe(4);
    expect(preview.records?.[1].replyToMessage?.message).toBe('groupInvite');
    expect(preview.records?.[2]).toMatchObject({
      redacted: false,
      forwardedThreadReplyCount: 4,
      replyToMessage: reply,
    });
  });
});
