import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/search/domain/message_search_target.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('MessageSearchTarget', () {
    test('targets the chat when result is a top-level message', () {
      final target = MessageSearchTarget.fromMessage(
        chatId: 42,
        message: _message(100),
      );

      expect(target.chatId, 42);
      expect(target.messageId, 100);
      expect(target.threadRootId, isNull);
    });

    test('targets the thread when result is a reply', () {
      final target = MessageSearchTarget.fromMessage(
        chatId: 42,
        message: _message(101, replyRootId: 55),
      );

      expect(target.chatId, 42);
      expect(target.messageId, 101);
      expect(target.threadRootId, 55);
    });
  });
}

MessageItemDto _message(int id, {int? replyRootId}) {
  return MessageItemDto(
    id: id,
    sender: const UserDto(uid: 7, gender: 0),
    chatId: 42,
    clientGeneratedId: 'client-$id',
    message: 'message $id',
    replyRootId: replyRootId,
  );
}
