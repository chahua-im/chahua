import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_layout_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_metrics_v2.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('action panel height follows visible grid rows', () {
    expect(
      MessageOverlayMetricsV2.actionPanelHeight(5),
      MessageOverlayMetricsV2.actionRowHeight,
    );
    expect(
      MessageOverlayMetricsV2.actionPanelHeight(6),
      (MessageOverlayMetricsV2.actionRowHeight * 2) +
          MessageOverlayMetricsV2.separatorHeight,
    );
    expect(
      MessageOverlayMetricsV2.actionPanelHeight(11),
      (MessageOverlayMetricsV2.actionRowHeight * 2) +
          MessageOverlayMetricsV2.separatorHeight,
    );
  });

  test('action panel width follows visible columns', () {
    final fourActionLayout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 4,
      showReactionBar: true,
    );
    final fiveActionLayout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 5,
      showReactionBar: true,
    );

    expect(
      fourActionLayout.actionPanelRect.width,
      lessThan(MessageOverlayMetricsV2.panelMaxWidth),
    );
    expect(
      fourActionLayout.actionPanelRect.width,
      greaterThanOrEqualTo(MessageOverlayMetricsV2.panelMinWidth),
    );
    expect(
      fiveActionLayout.actionPanelRect.width,
      MessageOverlayMetricsV2.panelMaxWidth,
    );
  });

  test('collapsed reaction bar width is independent from action count', () {
    final layout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 2,
      showReactionBar: true,
    );

    expect(
      layout.actionPanelRect.width,
      lessThan(layout.reactionBarRect!.width),
    );
    expect(
      layout.reactionBarRect!.width,
      MessageOverlayMetricsV2.panelMaxWidth,
    );
  });

  test('expanded reaction picker receives a large safe overlay rect', () {
    final layout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 4,
      showReactionBar: true,
      reactionPickerExpanded: true,
    );

    final rect = layout.reactionBarRect!;

    expect(rect.height, MessageOverlayMetricsV2.reactionPickerExpandedHeight);
    expect(rect.width, MessageOverlayMetricsV2.reactionPickerExpandedWidth);
    expect(rect.left, greaterThanOrEqualTo(layout.safeBounds.left));
    expect(rect.top, greaterThanOrEqualTo(layout.safeBounds.top));
    expect(rect.right, lessThanOrEqualTo(layout.safeBounds.right));
    expect(rect.bottom, lessThanOrEqualTo(layout.safeBounds.bottom));
    expect(rect.overlaps(layout.actionPanelRect), isFalse);
  });

  test('expanded reaction picker keeps the collapsed reaction side', () {
    final collapsedLayout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 4,
      showReactionBar: true,
    );
    final expandedLayout = MessageOverlayLayoutV2.calculate(
      viewportSize: const Size(390, 780),
      mediaPadding: EdgeInsets.zero,
      sourceBubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
      isMe: false,
      actionCount: 4,
      showReactionBar: true,
      reactionPickerExpanded: true,
    );

    expect(expandedLayout.reactionBarSide, collapsedLayout.reactionBarSide);
    expect(expandedLayout.actionPanelSide, collapsedLayout.actionPanelSide);
  });
}
