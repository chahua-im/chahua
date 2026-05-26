enum MessageSearchTagKind { from }

class MessageSearchTag {
  const MessageSearchTag.fromUser({required this.uid, required this.label})
    : kind = MessageSearchTagKind.from;

  final MessageSearchTagKind kind;
  final int uid;
  final String label;

  String get displayLabel => switch (kind) {
    MessageSearchTagKind.from => 'from: $label',
  };
}

class MessageSearchTagTrigger {
  const MessageSearchTagTrigger({
    required this.kind,
    required this.query,
    required this.triggerStart,
  });

  final MessageSearchTagKind kind;
  final String query;
  final int triggerStart;
}

MessageSearchTagTrigger? detectMessageSearchTagTrigger(
  String text,
  int cursorPosition,
) {
  if (cursorPosition <= 0 || cursorPosition > text.length) {
    return null;
  }

  var start = cursorPosition - 1;
  while (start >= 0 && !_isWhitespace(text[start])) {
    start--;
  }
  final tokenStart = start + 1;
  if (tokenStart > 0 && !_isWhitespace(text[tokenStart - 1])) {
    return null;
  }

  final token = text.substring(tokenStart, cursorPosition);
  const fromPrefix = 'from:';
  if (!token.startsWith(fromPrefix)) {
    return null;
  }

  final rawQuery = token.substring(fromPrefix.length);
  final query = rawQuery.startsWith('@') ? rawQuery.substring(1) : rawQuery;
  return MessageSearchTagTrigger(
    kind: MessageSearchTagKind.from,
    query: query,
    triggerStart: tokenStart,
  );
}

bool _isWhitespace(String value) => value.trim().isEmpty;
