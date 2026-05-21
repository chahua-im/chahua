import 'dart:math' as math;

import 'package:chahua/features/conversation/timeline/model/message_visibility_window.dart';
import 'package:flutter/foundation.dart';

@immutable
class TimelineMessageGeometry {
  const TimelineMessageGeometry({
    required this.stableKey,
    required this.top,
    required this.bottom,
    this.messageId,
  });

  final String stableKey;
  final int? messageId;
  final double top;
  final double bottom;

  double get center => top + ((bottom - top) / 2);

  bool overlaps(double viewportTop, double viewportBottom) {
    final visibleTop = math.max(top, viewportTop);
    final visibleBottom = math.min(bottom, viewportBottom);
    return visibleBottom > visibleTop;
  }
}

@immutable
class TimelineViewportAnchor {
  const TimelineViewportAnchor({
    required this.stableKey,
    required this.viewportDy,
    this.messageId,
  });

  final String stableKey;
  final int? messageId;
  final double viewportDy;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is TimelineViewportAnchor &&
            runtimeType == other.runtimeType &&
            stableKey == other.stableKey &&
            messageId == other.messageId &&
            viewportDy == other.viewportDy;
  }

  @override
  int get hashCode => Object.hash(stableKey, messageId, viewportDy);
}

@immutable
class TimelineViewportMessageSnapshot {
  const TimelineViewportMessageSnapshot({
    required this.stableKey,
    required this.topViewportDy,
    required this.bottomViewportDy,
    this.messageId,
  });

  final String stableKey;
  final int? messageId;
  final double topViewportDy;
  final double bottomViewportDy;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is TimelineViewportMessageSnapshot &&
            runtimeType == other.runtimeType &&
            stableKey == other.stableKey &&
            messageId == other.messageId &&
            topViewportDy == other.topViewportDy &&
            bottomViewportDy == other.bottomViewportDy;
  }

  @override
  int get hashCode =>
      Object.hash(stableKey, messageId, topViewportDy, bottomViewportDy);
}

@immutable
class TimelineViewportSnapshot {
  const TimelineViewportSnapshot({
    required this.isNearTop,
    required this.isNearBottom,
    required this.distanceToTop,
    required this.distanceToBottom,
    required this.viewportExtent,
    required this.viewportAtLiveEdge,
    this.centerAnchor,
    this.tail,
  });

  static const empty = TimelineViewportSnapshot(
    isNearTop: false,
    isNearBottom: true,
    distanceToTop: 0,
    distanceToBottom: 0,
    viewportExtent: 0,
    viewportAtLiveEdge: false,
  );

  final bool isNearTop;
  final bool isNearBottom;
  final double distanceToTop;
  final double distanceToBottom;
  final double viewportExtent;
  final bool viewportAtLiveEdge;
  final TimelineViewportAnchor? centerAnchor;
  final TimelineViewportMessageSnapshot? tail;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is TimelineViewportSnapshot &&
            runtimeType == other.runtimeType &&
            isNearTop == other.isNearTop &&
            isNearBottom == other.isNearBottom &&
            distanceToTop == other.distanceToTop &&
            distanceToBottom == other.distanceToBottom &&
            viewportExtent == other.viewportExtent &&
            viewportAtLiveEdge == other.viewportAtLiveEdge &&
            centerAnchor == other.centerAnchor &&
            tail == other.tail;
  }

  @override
  int get hashCode => Object.hash(
    isNearTop,
    isNearBottom,
    distanceToTop,
    distanceToBottom,
    viewportExtent,
    viewportAtLiveEdge,
    centerAnchor,
    tail,
  );
}

/// Computes where the center seam should sit for top-preferred jump placement.
double resolveTimelineTopPreferredAnchorAlignment({
  required double afterExtent,
  required double viewportExtent,
}) {
  if (viewportExtent <= 0) {
    return 0;
  }
  final visibleFractionBelowAnchor = (afterExtent / viewportExtent).clamp(
    0.0,
    1.0,
  );
  return 1.0 - visibleFractionBelowAnchor;
}

/// Resolves the first and last server-backed rows that intersect the viewport.
MessageVisibilityWindow? resolveTimelineMessageVisibilityWindow({
  required Iterable<TimelineMessageGeometry> measurements,
  required double viewportTop,
  required double viewportBottom,
}) {
  final visible = <({int messageId, double top})>[];
  for (final measurement in measurements) {
    final messageId = measurement.messageId;
    if (messageId == null) {
      continue;
    }
    final visibleTop = measurement.top.clamp(viewportTop, viewportBottom);
    final visibleBottom = measurement.bottom.clamp(viewportTop, viewportBottom);
    if (visibleBottom <= visibleTop) {
      continue;
    }
    visible.add((messageId: messageId, top: visibleTop));
  }
  if (visible.isEmpty) {
    return null;
  }
  visible.sort((a, b) => a.top.compareTo(b.top));
  return MessageVisibilityWindow(
    firstVisibleMessageId: visible.first.messageId,
    lastVisibleMessageId: visible.last.messageId,
  );
}

/// Selects a deterministic visible row anchor for future y-position restores.
TimelineViewportAnchor? resolveTimelineViewportAnchor({
  required Iterable<TimelineMessageGeometry> measurements,
  required double viewportTop,
  required double viewportBottom,
}) {
  TimelineMessageGeometry? bestMeasurement;
  double? bestDistanceFromCenter;
  final viewportCenter = viewportTop + ((viewportBottom - viewportTop) / 2);

  for (final measurement in measurements) {
    if (!measurement.overlaps(viewportTop, viewportBottom)) {
      continue;
    }
    final distanceFromCenter = (measurement.center - viewportCenter).abs();
    final previousDistance = bestDistanceFromCenter;
    if (previousDistance == null ||
        distanceFromCenter < previousDistance ||
        (distanceFromCenter == previousDistance &&
            measurement.top < bestMeasurement!.top)) {
      bestMeasurement = measurement;
      bestDistanceFromCenter = distanceFromCenter;
    }
  }

  if (bestMeasurement == null) {
    return null;
  }

  return TimelineViewportAnchor(
    stableKey: bestMeasurement.stableKey,
    messageId: bestMeasurement.messageId,
    viewportDy: bestMeasurement.top - viewportTop,
  );
}

/// Builds the viewport contract reported from the widget to the view model.
TimelineViewportSnapshot resolveTimelineViewportSnapshot({
  required Iterable<TimelineMessageGeometry> measurements,
  required String? renderedTailStableKey,
  required double viewportTop,
  required double viewportBottom,
  required double pixels,
  required double minScrollExtent,
  required double maxScrollExtent,
  required double edgeThreshold,
  double liveEdgeTolerance = 1.0,
}) {
  final materializedMeasurements = measurements.toList(growable: false);
  final distanceToTop = math.max(0.0, pixels - minScrollExtent);
  final distanceToBottom = math.max(0.0, maxScrollExtent - pixels);
  final viewportExtent = math.max(0.0, viewportBottom - viewportTop);
  TimelineViewportMessageSnapshot? tail;

  if (renderedTailStableKey != null) {
    for (final measurement in materializedMeasurements) {
      if (measurement.stableKey != renderedTailStableKey) {
        continue;
      }
      tail = TimelineViewportMessageSnapshot(
        stableKey: measurement.stableKey,
        messageId: measurement.messageId,
        topViewportDy: measurement.top - viewportTop,
        bottomViewportDy: measurement.bottom - viewportTop,
      );
      break;
    }
  }

  return TimelineViewportSnapshot(
    isNearTop: distanceToTop <= edgeThreshold,
    isNearBottom: distanceToBottom <= edgeThreshold,
    distanceToTop: distanceToTop,
    distanceToBottom: distanceToBottom,
    viewportExtent: viewportExtent,
    viewportAtLiveEdge:
        tail != null &&
        (tail.bottomViewportDy - viewportExtent).abs() <= liveEdgeTolerance,
    centerAnchor: resolveTimelineViewportAnchor(
      measurements: materializedMeasurements,
      viewportTop: viewportTop,
      viewportBottom: viewportBottom,
    ),
    tail: tail,
  );
}

/// Computes the scroll delta needed to restore an anchor to its old viewport y.
double resolveTimelineAnchorCorrectionDelta({
  required double previousViewportDy,
  required double currentViewportDy,
}) {
  return currentViewportDy - previousViewportDy;
}

/// Applies an anchor correction delta to the current scroll offset.
double resolveTimelineAnchorCorrectedOffset({
  required double currentScrollOffset,
  required double previousViewportDy,
  required double currentViewportDy,
}) {
  return currentScrollOffset +
      resolveTimelineAnchorCorrectionDelta(
        previousViewportDy: previousViewportDy,
        currentViewportDy: currentViewportDy,
      );
}
