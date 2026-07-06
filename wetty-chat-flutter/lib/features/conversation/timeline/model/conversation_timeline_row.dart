import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter/foundation.dart';

@immutable
abstract class ConversationTimelineRow {
  const ConversationTimelineRow();

  String get stableKey;
}

class ConversationTimelineDateSeparatorRow extends ConversationTimelineRow {
  const ConversationTimelineDateSeparatorRow({required this.day});

  final DateTime day;

  @override
  String get stableKey => 'date:${conversationTimelineDateKey(day)}';
}

class ConversationTimelineMessageRow extends ConversationTimelineRow {
  const ConversationTimelineMessageRow({required this.message});

  final ConversationMessageV2 message;

  @override
  String get stableKey => message.stableKey;
}

List<ConversationTimelineRow> buildConversationTimelineRows(
  List<ConversationMessageV2> messages, {
  ConversationMessageV2? previousMessage,
}) {
  final rows = <ConversationTimelineRow>[];
  var lastMessage = previousMessage;

  for (final message in messages) {
    final day = conversationTimelineLocalDay(message.createdAt);
    final previousDay = conversationTimelineLocalDay(lastMessage?.createdAt);
    if (day != null && (previousDay == null || day != previousDay)) {
      rows.add(ConversationTimelineDateSeparatorRow(day: day));
    }
    rows.add(ConversationTimelineMessageRow(message: message));
    lastMessage = message;
  }

  return rows;
}

DateTime? conversationTimelineLocalDay(DateTime? timestamp) {
  if (timestamp == null) {
    return null;
  }
  final localTimestamp = timestamp.toLocal();
  return DateTime(
    localTimestamp.year,
    localTimestamp.month,
    localTimestamp.day,
  );
}

String conversationTimelineDateKey(DateTime day) {
  final localDay = conversationTimelineLocalDay(day)!;
  final month = localDay.month.toString().padLeft(2, '0');
  final date = localDay.day.toString().padLeft(2, '0');
  return '${localDay.year}-$month-$date';
}
