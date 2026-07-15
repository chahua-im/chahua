import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('forwarded preview DTO maps to forwarded content', () {
    final message = ConversationMessageV2.fromMessageItemDto(
      MessageItemDto(
        id: 100,
        message: 'Forwarded 2 messages',
        messageType: 'forwarded',
        sender: const UserDto(uid: 1, name: 'Alice'),
        chatId: 10,
        clientGeneratedId: 'forwarded-client',
        forwardedPreview: const ForwardedMessagesPreviewDto(
          total: 2,
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
    expect(content, isA<ForwardedMessageContent>());
    final forwarded = content as ForwardedMessageContent;
    expect(forwarded.total, 2);
    expect(forwarded.previewMessages, hasLength(1));
    expect(forwarded.previewMessages.single.originalMessageId, 20);
    expect(forwarded.previewMessages.single.sender.name, 'Bob');
    expect(forwarded.previewMessages.single.mentions.single.username, 'Carol');
  });
}
