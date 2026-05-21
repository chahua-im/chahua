import 'package:chahua/core/api/models/messages_api_models.dart';

class MessageSearchTarget {
  const MessageSearchTarget({
    required this.chatId,
    required this.messageId,
    this.threadRootId,
  });

  final int chatId;
  final int messageId;
  final int? threadRootId;

  factory MessageSearchTarget.fromMessage({
    required int chatId,
    required MessageItemDto message,
  }) {
    return MessageSearchTarget(
      chatId: chatId,
      messageId: message.id,
      threadRootId: message.replyRootId,
    );
  }
}
