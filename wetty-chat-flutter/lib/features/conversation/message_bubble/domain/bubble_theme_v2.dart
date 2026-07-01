import 'dart:math' as math;

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/shared/presentation/chat_timestamp_formatter.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter/cupertino.dart';

const double _maxRowWidthFactor = 0.80;
const double _rowHorizontalPadding = 24;
const double _avatarSlotWidth = 36;
const double _avatarGap = 8;

class BubbleThemeV2 extends InheritedWidget {
  const BubbleThemeV2({
    super.key,
    required this.isMe,
    required this.isInteractive,
    this.isTextSelectable = false,
    this.showDeliveryStatus = true,
    required this.maxBubbleWidth,
    required this.timeSpacerWidth,
    required this.chatMessageFontSize,
    required this.bubbleColor,
    required this.textColor,
    required this.metaColor,
    required this.linkColor,
    required super.child,
  });

  factory BubbleThemeV2.fromContext({
    Key? key,
    required BuildContext context,
    required ConversationMessageV2 message,
    required bool isMe,
    required bool isInteractive,
    bool isTextSelectable = false,
    bool showDeliveryStatus = true,
    required double chatMessageFontSize,
    double? timelineViewportWidth,
    required Widget child,
  }) {
    final colors = context.appColors;
    final viewportWidth =
        timelineViewportWidth ?? MediaQuery.sizeOf(context).width;
    final timeText = formatChatMessageTime(context, message.createdAt);
    return BubbleThemeV2(
      key: key,
      isMe: isMe,
      isInteractive: isInteractive,
      isTextSelectable: isTextSelectable,
      showDeliveryStatus: showDeliveryStatus,
      maxBubbleWidth: math.max(
        0,
        (viewportWidth * _maxRowWidthFactor) -
            _rowHorizontalPadding -
            _avatarSlotWidth -
            _avatarGap,
      ),
      timeSpacerWidth:
          measureMetaWidth(
            context,
            message,
            timeText,
            isMe: isMe,
            showDeliveryStatus: showDeliveryStatus,
          ) +
          8,
      chatMessageFontSize: chatMessageFontSize,
      bubbleColor: isMe ? colors.chatSentBubble : colors.chatReceivedBubble,
      textColor: isMe ? colors.textOnAccent : colors.textPrimary,
      metaColor: isMe ? colors.chatSentMeta : colors.chatReceivedMeta,
      linkColor: isMe ? colors.chatLinkOnSent : colors.chatLinkOnReceived,
      child: child,
    );
  }

  final bool isMe;
  final bool isInteractive;
  final bool isTextSelectable;
  final bool showDeliveryStatus;
  final double maxBubbleWidth;
  final double timeSpacerWidth;
  final double chatMessageFontSize;
  final Color bubbleColor;
  final Color textColor;
  final Color metaColor;
  final Color linkColor;

  double get minBubbleContentHeight => AppFontSizes.bodyLarge * 1.28;

  static BubbleThemeV2 of(BuildContext context) {
    final theme = context.dependOnInheritedWidgetOfExactType<BubbleThemeV2>();
    assert(theme != null, 'BubbleThemeV2.of() called without an ancestor');
    return theme!;
  }

  @override
  bool updateShouldNotify(BubbleThemeV2 old) {
    return isMe != old.isMe ||
        isInteractive != old.isInteractive ||
        isTextSelectable != old.isTextSelectable ||
        showDeliveryStatus != old.showDeliveryStatus ||
        maxBubbleWidth != old.maxBubbleWidth ||
        timeSpacerWidth != old.timeSpacerWidth ||
        chatMessageFontSize != old.chatMessageFontSize ||
        bubbleColor != old.bubbleColor ||
        textColor != old.textColor ||
        metaColor != old.metaColor ||
        linkColor != old.linkColor;
  }
}

const double _statusIconSize = 14;
const double _statusIconGap = 4;

double measureMetaWidth(
  BuildContext context,
  ConversationMessageV2 message,
  String timeStr, {
  required bool isMe,
  required bool showDeliveryStatus,
}) {
  final metaText = message.isEdited ? 'edited $timeStr' : timeStr;
  final metaPainter = TextPainter(
    text: TextSpan(
      text: metaText,
      style: appBubbleMetaTextStyle(
        context,
        fontSize: AppFontSizes.caption,
        fontWeight: AppFontWeights.regular,
      ),
    ),
    maxLines: 1,
    textDirection: TextDirection.ltr,
  )..layout(maxWidth: double.infinity);

  final showsDelivery =
      showDeliveryStatus &&
      isMe &&
      message.deliveryState != ConversationDeliveryState.failed;
  if (showsDelivery) {
    return metaPainter.width + _statusIconGap + _statusIconSize;
  }
  return metaPainter.width;
}
