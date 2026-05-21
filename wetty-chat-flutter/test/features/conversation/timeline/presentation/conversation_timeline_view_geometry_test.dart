import 'package:chahua/features/conversation/timeline/model/timeline_viewport_geometry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('resolveTimelineTopPreferredAnchorAlignment', () {
    test('returns 0 when viewport has no extent', () {
      expect(
        resolveTimelineTopPreferredAnchorAlignment(
          afterExtent: 100,
          viewportExtent: 0,
        ),
        0,
      );
    });

    test('places seam lower when after content is shorter than viewport', () {
      expect(
        resolveTimelineTopPreferredAnchorAlignment(
          afterExtent: 150,
          viewportExtent: 600,
        ),
        closeTo(0.75, 0.001),
      );
    });

    test('places seam at top when after content fills the viewport', () {
      expect(
        resolveTimelineTopPreferredAnchorAlignment(
          afterExtent: 600,
          viewportExtent: 600,
        ),
        0,
      );
    });

    test('clamps overfull after content to top placement', () {
      expect(
        resolveTimelineTopPreferredAnchorAlignment(
          afterExtent: 900,
          viewportExtent: 600,
        ),
        0,
      );
    });
  });

  group('resolveTimelineMessageVisibilityWindow', () {
    test('ignores rows without server ids and rows outside the viewport', () {
      final window = resolveTimelineMessageVisibilityWindow(
        viewportTop: 100,
        viewportBottom: 300,
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'client:local',
            top: 110,
            bottom: 150,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:1',
            messageId: 1,
            top: 10,
            bottom: 90,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:2',
            messageId: 2,
            top: 120,
            bottom: 180,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:3',
            messageId: 3,
            top: 260,
            bottom: 360,
          ),
        ],
      );

      expect(window?.firstVisibleMessageId, 2);
      expect(window?.lastVisibleMessageId, 3);
    });

    test('returns null when no server-backed row intersects the viewport', () {
      final window = resolveTimelineMessageVisibilityWindow(
        viewportTop: 100,
        viewportBottom: 300,
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:1',
            messageId: 1,
            top: 10,
            bottom: 90,
          ),
          TimelineMessageGeometry(
            stableKey: 'client:local',
            top: 120,
            bottom: 180,
          ),
        ],
      );

      expect(window, isNull);
    });

    test('orders visible rows by clipped top edge', () {
      final window = resolveTimelineMessageVisibilityWindow(
        viewportTop: 100,
        viewportBottom: 300,
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:5',
            messageId: 5,
            top: 250,
            bottom: 310,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:4',
            messageId: 4,
            top: 90,
            bottom: 140,
          ),
        ],
      );

      expect(window?.firstVisibleMessageId, 4);
      expect(window?.lastVisibleMessageId, 5);
    });
  });

  group('resolveTimelineViewportAnchor', () {
    test('chooses the visible row closest to the viewport center', () {
      final anchor = resolveTimelineViewportAnchor(
        viewportTop: 100,
        viewportBottom: 500,
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:1',
            messageId: 1,
            top: 120,
            bottom: 180,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:2',
            messageId: 2,
            top: 260,
            bottom: 340,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:3',
            messageId: 3,
            top: 430,
            bottom: 520,
          ),
        ],
      );

      expect(anchor?.stableKey, 'server:2');
      expect(anchor?.messageId, 2);
      expect(anchor?.viewportDy, 160);
    });

    test(
      'uses the earlier row as a deterministic center-distance tiebreaker',
      () {
        final anchor = resolveTimelineViewportAnchor(
          viewportTop: 0,
          viewportBottom: 400,
          measurements: const [
            TimelineMessageGeometry(
              stableKey: 'server:lower',
              messageId: 2,
              top: 260,
              bottom: 340,
            ),
            TimelineMessageGeometry(
              stableKey: 'server:upper',
              messageId: 1,
              top: 60,
              bottom: 140,
            ),
          ],
        );

        expect(anchor?.stableKey, 'server:upper');
        expect(anchor?.viewportDy, 60);
      },
    );

    test('returns null when no row overlaps the viewport', () {
      expect(
        resolveTimelineViewportAnchor(
          viewportTop: 100,
          viewportBottom: 300,
          measurements: const [
            TimelineMessageGeometry(
              stableKey: 'server:1',
              messageId: 1,
              top: 10,
              bottom: 90,
            ),
          ],
        ),
        isNull,
      );
    });
  });

  group('resolveTimelineViewportSnapshot', () {
    test('marks the viewport at live edge when the tail is bottom pinned', () {
      final snapshot = resolveTimelineViewportSnapshot(
        viewportTop: 100,
        viewportBottom: 700,
        pixels: 400,
        minScrollExtent: 0,
        maxScrollExtent: 400,
        edgeThreshold: 80,
        renderedTailStableKey: 'server:20',
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:19',
            messageId: 19,
            top: 560,
            bottom: 620,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:20',
            messageId: 20,
            top: 620,
            bottom: 700,
          ),
        ],
      );

      expect(snapshot.isNearBottom, isTrue);
      expect(snapshot.distanceToBottom, 0);
      expect(snapshot.viewportExtent, 600);
      expect(snapshot.tail?.bottomViewportDy, 600);
      expect(snapshot.viewportAtLiveEdge, isTrue);
    });

    test('distinguishes near bottom from visually pinned live edge', () {
      final snapshot = resolveTimelineViewportSnapshot(
        viewportTop: 100,
        viewportBottom: 700,
        pixels: 352,
        minScrollExtent: 0,
        maxScrollExtent: 400,
        edgeThreshold: 80,
        renderedTailStableKey: 'server:20',
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:20',
            messageId: 20,
            top: 650,
            bottom: 729,
          ),
        ],
      );

      expect(snapshot.distanceToBottom, 48);
      expect(snapshot.isNearBottom, isTrue);
      expect(snapshot.tail?.bottomViewportDy, 629);
      expect(snapshot.viewportAtLiveEdge, isFalse);
    });

    test('marks the viewport away from bottom outside the edge threshold', () {
      final snapshot = resolveTimelineViewportSnapshot(
        viewportTop: 100,
        viewportBottom: 700,
        pixels: 240,
        minScrollExtent: 0,
        maxScrollExtent: 400,
        edgeThreshold: 80,
        renderedTailStableKey: 'server:20',
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:20',
            messageId: 20,
            top: 500,
            bottom: 580,
          ),
        ],
      );

      expect(snapshot.distanceToBottom, 160);
      expect(snapshot.isNearBottom, isFalse);
      expect(snapshot.viewportAtLiveEdge, isFalse);
    });

    test('does not report live edge when the rendered tail is missing', () {
      final snapshot = resolveTimelineViewportSnapshot(
        viewportTop: 100,
        viewportBottom: 700,
        pixels: 400,
        minScrollExtent: 0,
        maxScrollExtent: 400,
        edgeThreshold: 80,
        renderedTailStableKey: 'server:20',
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:19',
            messageId: 19,
            top: 620,
            bottom: 700,
          ),
        ],
      );

      expect(snapshot.tail, isNull);
      expect(snapshot.viewportAtLiveEdge, isFalse);
    });

    test('includes the center-preferred visible anchor', () {
      final snapshot = resolveTimelineViewportSnapshot(
        viewportTop: 100,
        viewportBottom: 500,
        pixels: 200,
        minScrollExtent: 0,
        maxScrollExtent: 200,
        edgeThreshold: 80,
        renderedTailStableKey: 'server:3',
        measurements: const [
          TimelineMessageGeometry(
            stableKey: 'server:1',
            messageId: 1,
            top: 120,
            bottom: 180,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:2',
            messageId: 2,
            top: 260,
            bottom: 340,
          ),
          TimelineMessageGeometry(
            stableKey: 'server:3',
            messageId: 3,
            top: 430,
            bottom: 500,
          ),
        ],
      );

      expect(snapshot.centerAnchor?.stableKey, 'server:2');
      expect(snapshot.centerAnchor?.messageId, 2);
      expect(snapshot.centerAnchor?.viewportDy, 160);
    });
  });

  group('resolveTimelineAnchorCorrectedOffset', () {
    test(
      'increases scroll offset when the anchor moved lower in the viewport',
      () {
        expect(
          resolveTimelineAnchorCorrectedOffset(
            currentScrollOffset: 400,
            previousViewportDy: 180,
            currentViewportDy: 230,
          ),
          450,
        );
      },
    );

    test(
      'decreases scroll offset when the anchor moved higher in the viewport',
      () {
        expect(
          resolveTimelineAnchorCorrectedOffset(
            currentScrollOffset: 400,
            previousViewportDy: 180,
            currentViewportDy: 120,
          ),
          340,
        );
      },
    );
  });
}
