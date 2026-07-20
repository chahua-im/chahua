import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('formatReplyPreview', () {
    const sender = User(uid: 1, name: 'Alice');

    test('formats plain text replies', () {
      const preview = ReplyToMessage(
        id: 1,
        message: 'Hello world',
        sender: sender,
        isDeleted: false,
      );

      expect(formatReplyPreview(preview), 'Hello world');
    });

    test('formats deleted replies', () {
      const preview = ReplyToMessage(id: 1, sender: sender, isDeleted: true);

      expect(formatReplyPreview(preview), deletedPreviewLabel);
    });

    test('formats sticker replies with emoji', () {
      const preview = ReplyToMessage(
        id: 1,
        messageType: 'sticker',
        sticker: StickerSummary(id: 'sticker-1', emoji: '🙂'),
        sender: sender,
        isDeleted: false,
      );

      expect(formatReplyPreview(preview), '[Sticker] 🙂');
    });

    test('formats audio replies', () {
      const preview = ReplyToMessage(
        id: 1,
        messageType: 'audio',
        sender: sender,
        isDeleted: false,
      );

      expect(formatReplyPreview(preview), voiceMessagePreviewLabel);
    });

    test('formats image attachment replies', () {
      const preview = ReplyToMessage(
        id: 1,
        sender: sender,
        isDeleted: false,
        attachmentKinds: ['image/png'],
      );

      expect(formatReplyPreview(preview), imagePreviewLabel);
    });

    test('formats video attachment replies from first attachment kind', () {
      const preview = ReplyToMessage(
        id: 1,
        sender: sender,
        isDeleted: false,
        attachmentKinds: ['video/mp4'],
      );

      expect(formatReplyPreview(preview), videoPreviewLabel);
    });

    test('formats generic attachment replies', () {
      const preview = ReplyToMessage(
        id: 1,
        sender: sender,
        isDeleted: false,
        attachmentKinds: ['application/pdf'],
      );

      expect(formatReplyPreview(preview), attachmentPreviewLabel);
    });

    test('formats every attachment kind before message text', () {
      const preview = ReplyToMessage(
        id: 1,
        message: 'See these files',
        sender: sender,
        isDeleted: false,
        attachmentKinds: ['image/png', 'application/pdf', 'video/mp4'],
      );

      expect(
        formatReplyPreview(preview),
        '[Image][Attachment][Video] See these files',
      );
    });

    test('renders mentions as usernames', () {
      const preview = ReplyToMessage(
        id: 1,
        message: 'hi @[uid:42]',
        sender: sender,
        isDeleted: false,
        mentions: [MentionInfo(uid: 42, username: 'bob')],
      );

      expect(formatReplyPreview(preview), 'hi @bob');
    });

    test('falls back to user id when mention username is missing', () {
      const preview = ReplyToMessage(
        id: 1,
        message: 'hi @[uid:42]',
        sender: sender,
        isDeleted: false,
        mentions: [MentionInfo(uid: 42)],
      );

      expect(formatReplyPreview(preview), 'hi @User 42');
    });
  });
}
