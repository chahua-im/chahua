import 'package:flutter/foundation.dart';

@immutable
class ConversationMessageHighlight {
  const ConversationMessageHighlight({
    required this.stableKey,
    required this.generation,
    required this.startedAt,
  });

  static const visibleDuration = Duration(milliseconds: 2800);
  static const fadeDuration = Duration(milliseconds: 650);
  static const totalDuration = Duration(milliseconds: 3450);

  final String stableKey;
  final int generation;
  final DateTime startedAt;

  double animationProgress(DateTime now) {
    final elapsed = now.difference(startedAt);
    if (elapsed <= Duration.zero) {
      return 0;
    }
    return (elapsed.inMicroseconds / totalDuration.inMicroseconds).clamp(
      0.0,
      1.0,
    );
  }

  double opacityAt(DateTime now) {
    final elapsed = now.difference(startedAt);
    if (elapsed <= visibleDuration) {
      return 1;
    }
    if (elapsed >= totalDuration) {
      return 0;
    }
    final fadeElapsed = elapsed - visibleDuration;
    final fadeProgress =
        fadeElapsed.inMicroseconds / fadeDuration.inMicroseconds;
    return (1 - fadeProgress).clamp(0.0, 1.0);
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is ConversationMessageHighlight &&
            stableKey == other.stableKey &&
            generation == other.generation &&
            startedAt == other.startedAt;
  }

  @override
  int get hashCode => Object.hash(stableKey, generation, startedAt);
}
