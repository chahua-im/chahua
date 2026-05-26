import 'package:chahua/features/conversation/search/domain/message_search_tag.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('detectMessageSearchTagTrigger', () {
    test('detects a from tag with an empty query', () {
      final trigger = detectMessageSearchTagTrigger('from:', 5);

      expect(trigger, isNotNull);
      expect(trigger!.kind, MessageSearchTagKind.from);
      expect(trigger.query, isEmpty);
      expect(trigger.triggerStart, 0);
    });

    test('strips an optional at-sign from from tag queries', () {
      final trigger = detectMessageSearchTagTrigger('budget from:@ali', 16);

      expect(trigger, isNotNull);
      expect(trigger!.query, 'ali');
      expect(trigger.triggerStart, 7);
    });

    test('does not detect from text inside another token', () {
      final trigger = detectMessageSearchTagTrigger('beforefrom:@ali', 15);

      expect(trigger, isNull);
    });
  });

  group('MessageSearchTag', () {
    test('formats a from-user tag for inline display', () {
      const tag = MessageSearchTag.fromUser(uid: 7, label: 'Alice');

      expect(tag.displayLabel, 'from: Alice');
    });
  });
}
