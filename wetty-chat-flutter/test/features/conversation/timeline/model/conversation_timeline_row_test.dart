import 'package:chahua/features/conversation/timeline/model/conversation_timeline_row.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('buildConversationTimelineRows', () {
    test('adds a date separator before the first dated message', () {
      final rows = buildConversationTimelineRows([
        _message(1, createdAt: DateTime(2026, 7, 2, 9)),
      ]);

      expect(rows, hasLength(2));
      expect(rows[0], isA<ConversationTimelineDateSeparatorRow>());
      expect(rows[1], isA<ConversationTimelineMessageRow>());
    });

    test('adds date separators only when the local day changes', () {
      final rows = buildConversationTimelineRows([
        _message(1, createdAt: DateTime(2026, 7, 2, 9)),
        _message(2, createdAt: DateTime(2026, 7, 2, 10)),
        _message(3, createdAt: DateTime(2026, 7, 3, 9)),
      ]);

      expect(rows.map((row) => row.stableKey), <String>[
        'date:2026-07-02',
        'client:client-1',
        'client:client-2',
        'date:2026-07-03',
        'client:client-3',
      ]);
    });

    test(
      'continues from a previous slice without duplicating same-day date',
      () {
        final rows = buildConversationTimelineRows([
          _message(2, createdAt: DateTime(2026, 7, 2, 10)),
        ], previousMessage: _message(1, createdAt: DateTime(2026, 7, 2, 9)));

        expect(rows.map((row) => row.stableKey), <String>['client:client-2']);
      },
    );
  });
}

ConversationMessageV2 _message(int id, {required DateTime createdAt}) {
  return ConversationMessageV2(
    serverMessageId: id,
    clientGeneratedId: 'client-$id',
    sender: const User(uid: 7, name: 'Sender 7'),
    createdAt: createdAt,
    content: TextMessageContent(text: 'message $id'),
  );
}
