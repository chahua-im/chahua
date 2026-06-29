import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('forwarded message DTO maps to forwarded content', () {
    final message = ConversationMessageV2.fromMessageItemDto(
      MessageItemDto(
        id: 100,
        message: 'Forwarded 2 messages',
        messageType: 'forwarded',
        sender: const UserDto(uid: 1, name: 'Alice'),
        chatId: 10,
        clientGeneratedId: 'forwarded-client',
        forwardedMessages: const <ForwardedMessageSnapshotDto>[
          ForwardedMessageSnapshotDto(
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
    );

    final content = message.content;
    expect(content, isA<ForwardedMessageContent>());
    final forwarded = content as ForwardedMessageContent;
    expect(forwarded.messages, hasLength(1));
    expect(forwarded.messages.single.originalMessageId, 20);
    expect(forwarded.messages.single.sender.name, 'Bob');
    expect(
      (forwarded.messages.single.content as TextMessageContent)
          .mentions
          .single
          .username,
      'Carol',
    );
  });
}
