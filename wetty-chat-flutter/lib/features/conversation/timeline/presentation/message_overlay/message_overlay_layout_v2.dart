import 'dart:math' as math;

import 'package:flutter/cupertino.dart';

import 'message_overlay_metrics_v2.dart';

enum MessageOverlaySideV2 { above, below }

class MessageOverlayLayoutV2 {
  const MessageOverlayLayoutV2({
    required this.bubbleRect,
    required this.actionPanelRect,
    required this.actionPanelSide,
    required this.safeBounds,
    this.reactionBarRect,
    this.reactionBarSide,
  });

  final Rect bubbleRect;
  final Rect actionPanelRect;
  final MessageOverlaySideV2 actionPanelSide;
  final Rect? reactionBarRect;
  final MessageOverlaySideV2? reactionBarSide;
  final Rect safeBounds;

  static MessageOverlayLayoutV2 calculate({
    required Size viewportSize,
    required EdgeInsets mediaPadding,
    required Rect sourceBubbleRect,
    required bool isMe,
    required int actionCount,
    required bool showReactionBar,
    bool reactionPickerExpanded = false,
  }) {
    final safeBounds = _safeBounds(viewportSize, mediaPadding);
    final bubbleRect = _bubbleRect(
      sourceBubbleRect: sourceBubbleRect,
      safeBounds: safeBounds,
      isMe: isMe,
    );
    final panelWidth = MessageOverlayMetricsV2.actionPanelWidth(
      actionCount,
      safeBounds.width,
    );
    final panelHeight = MessageOverlayMetricsV2.actionPanelHeight(actionCount);
    final reactionHeight = showReactionBar
        ? _reactionPickerHeight(reactionPickerExpanded)
        : 0.0;
    final reactionSideSelectionHeight = showReactionBar
        ? _reactionPickerHeight(false)
        : 0.0;
    final reactionWidth = showReactionBar
        ? _reactionPickerWidth(safeBounds.width, reactionPickerExpanded)
        : 0.0;
    final aboveSpace =
        bubbleRect.top - safeBounds.top - MessageOverlayMetricsV2.gap;
    final belowSpace =
        safeBounds.bottom - bubbleRect.bottom - MessageOverlayMetricsV2.gap;

    final actionSide = _actionPanelSide(
      panelHeight: panelHeight,
      reactionHeight: reactionSideSelectionHeight,
      aboveSpace: aboveSpace,
      belowSpace: belowSpace,
      showReactionBar: showReactionBar,
    );
    final reactionSide = showReactionBar ? _opposite(actionSide) : null;

    return MessageOverlayLayoutV2(
      bubbleRect: bubbleRect,
      actionPanelRect: _controlRect(
        bubbleRect: bubbleRect,
        safeBounds: safeBounds,
        isMe: isMe,
        side: actionSide,
        width: panelWidth,
        height: panelHeight,
      ),
      actionPanelSide: actionSide,
      reactionBarRect: showReactionBar
          ? _controlRect(
              bubbleRect: bubbleRect,
              safeBounds: safeBounds,
              isMe: isMe,
              side: reactionSide!,
              width: reactionWidth,
              height: reactionHeight,
            )
          : null,
      reactionBarSide: reactionSide,
      safeBounds: safeBounds,
    );
  }

  static Rect _safeBounds(Size viewportSize, EdgeInsets mediaPadding) {
    final left = MessageOverlayMetricsV2.screenPadding;
    final top = mediaPadding.top + MessageOverlayMetricsV2.screenPadding;
    final right = math.max(
      left,
      viewportSize.width - MessageOverlayMetricsV2.screenPadding,
    );
    final bottom = math.max(
      top,
      viewportSize.height -
          mediaPadding.bottom -
          MessageOverlayMetricsV2.screenPadding,
    );
    return Rect.fromLTRB(left, top, right, bottom);
  }

  static Rect _bubbleRect({
    required Rect sourceBubbleRect,
    required Rect safeBounds,
    required bool isMe,
  }) {
    final width = math.min(sourceBubbleRect.width, safeBounds.width);
    final height = math.min(sourceBubbleRect.height, safeBounds.height);
    final preferredLeft = isMe
        ? sourceBubbleRect.right - width
        : sourceBubbleRect.left;
    final left = preferredLeft
        .clamp(safeBounds.left, safeBounds.right - width)
        .toDouble();
    final top = sourceBubbleRect.height > safeBounds.height
        ? safeBounds.top
        : sourceBubbleRect.top
              .clamp(safeBounds.top, safeBounds.bottom - height)
              .toDouble();
    return Rect.fromLTWH(left, top, width, height);
  }

  static double _reactionPickerHeight(bool expanded) {
    if (expanded) {
      return MessageOverlayMetricsV2.reactionPickerExpandedHeight;
    }
    return MessageOverlayMetricsV2.reactionBarHeight;
  }

  static double _reactionPickerWidth(double safeWidth, bool expanded) {
    if (!expanded) {
      return MessageOverlayMetricsV2.reactionBarWidth(safeWidth);
    }
    return math
        .min(MessageOverlayMetricsV2.reactionPickerExpandedWidth, safeWidth)
        .toDouble();
  }

  static MessageOverlaySideV2 _actionPanelSide({
    required double panelHeight,
    required double reactionHeight,
    required double aboveSpace,
    required double belowSpace,
    required bool showReactionBar,
  }) {
    if (!showReactionBar) {
      if (belowSpace >= panelHeight || belowSpace >= aboveSpace) {
        return MessageOverlaySideV2.below;
      }
      return MessageOverlaySideV2.above;
    }

    final tallerControlIsPanel = panelHeight >= reactionHeight;
    final tallerSide = belowSpace >= aboveSpace
        ? MessageOverlaySideV2.below
        : MessageOverlaySideV2.above;
    return tallerControlIsPanel ? tallerSide : _opposite(tallerSide);
  }

  static Rect _controlRect({
    required Rect bubbleRect,
    required Rect safeBounds,
    required bool isMe,
    required MessageOverlaySideV2 side,
    required double width,
    required double height,
  }) {
    final preferredLeft = isMe ? bubbleRect.right - width : bubbleRect.left;
    final left = preferredLeft
        .clamp(safeBounds.left, safeBounds.right - width)
        .toDouble();
    final preferredTop = switch (side) {
      MessageOverlaySideV2.above =>
        bubbleRect.top - MessageOverlayMetricsV2.gap - height,
      MessageOverlaySideV2.below =>
        bubbleRect.bottom + MessageOverlayMetricsV2.gap,
    };
    final top = height > safeBounds.height
        ? safeBounds.top
        : preferredTop
              .clamp(safeBounds.top, safeBounds.bottom - height)
              .toDouble();
    return Rect.fromLTWH(left, top, width, height);
  }

  static MessageOverlaySideV2 _opposite(MessageOverlaySideV2 side) {
    return switch (side) {
      MessageOverlaySideV2.above => MessageOverlaySideV2.below,
      MessageOverlaySideV2.below => MessageOverlaySideV2.above,
    };
  }
}
