import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('forwarded response maps nested preview to forwarded content', () {
    final message = ForwardedMessage.fromDto(
      const ForwardedMessageResponseDto(
        originalMessageId: 100,
        originalChatId: 10,
        forwardedBundleId: 'bundle-nested-100',
        message: 'Forwarded message',
        messageType: 'forwarded',
        sender: UserDto(uid: 1, name: 'Alice'),
        forwardedPreview: ForwardedMessagesPreviewDto(
          total: 2,
          containsForwardedMessages: true,
          messages: <ForwardedMessagePreviewDto>[
            ForwardedMessagePreviewDto(
              originalMessageId: 20,
              originalChatId: 10,
              message: 'Nested message',
              sender: UserDto(uid: 2, name: 'Bob'),
            ),
          ],
        ),
      ),
    );

    expect(message.content, isA<ForwardedPreviewContent>());
    final content = message.content as ForwardedPreviewContent;
    expect(message.forwardedBundleId, 'bundle-nested-100');
    expect(content.total, 2);
    expect(content.containsForwardedMessages, isTrue);
    expect(content.previewMessages.single.message, 'Nested message');
  });

  test('forwarded preview DTO maps to forwarded content', () {
    final message = ConversationMessageV2.fromMessageItemDto(
      MessageItemDto(
        id: 100,
        message: 'Forwarded 2 messages',
        messageType: 'forwarded',
        forwardedBundleId: 'bundle-root-100',
        sender: const UserDto(uid: 1, name: 'Alice'),
        chatId: 10,
        clientGeneratedId: 'forwarded-client',
        forwardedPreview: const ForwardedMessagesPreviewDto(
          total: 2,
          containsForwardedMessages: true,
          messages: <ForwardedMessagePreviewDto>[
            ForwardedMessagePreviewDto(
              originalMessageId: 20,
              originalChatId: 10,
              message: 'hello',
              sender: UserDto(uid: 2, name: 'Bob'),
              mentions: <MentionInfoDto>[
                MentionInfoDto(uid: 3, username: 'Carol'),
              ],
            ),
          ],
        ),
      ),
    );

    final content = message.content;
    expect(message.chatId, 10);
    expect(content, isA<ForwardedPreviewContent>());
    final forwarded = content as ForwardedPreviewContent;
    expect(forwarded.forwardedBundleId, 'bundle-root-100');
    expect(forwarded.containsForwardedMessages, isTrue);
    expect(forwarded.total, 2);
    expect(forwarded.previewMessages, hasLength(1));
    expect(forwarded.previewMessages.single.originalMessageId, 20);
    expect(forwarded.previewMessages.single.sender.name, 'Bob');
    expect(forwarded.previewMessages.single.mentions.single.username, 'Carol');
  });
}
