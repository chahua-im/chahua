import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/shared/presentation/chat_timestamp_formatter.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter/cupertino.dart';

import '../../domain/bubble_theme_v2.dart';

const double _statusIconSize = 14;
const double _statusIconGap = 4;

class MetaFooter extends StatelessWidget {
  const MetaFooter({
    super.key,
    required this.message,
    this.color,
    this.fontWeight = AppFontWeights.regular,
  });

  final ConversationMessageV2 message;
  final FontWeight fontWeight;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = BubbleThemeV2.of(context);
    final metaColor = color ?? theme.metaColor;
    final timeText = formatChatMessageTime(context, message.createdAt);
    final showDeliveryStatus =
        theme.showDeliveryStatus &&
        theme.isMe &&
        message.deliveryState != ConversationDeliveryState.failed;
    final deliveryIndicator = switch (message.deliveryState) {
      ConversationDeliveryState.sending ||
      ConversationDeliveryState.sent => Icon(
        CupertinoIcons.checkmark_alt_circle,
        size: _statusIconSize,
        color: metaColor,
      ),
      ConversationDeliveryState.confirmed => Icon(
        CupertinoIcons.checkmark_alt_circle_fill,
        size: _statusIconSize,
        color: metaColor,
      ),
      _ => null,
    };

    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (message.isEdited)
          Padding(
            padding: const EdgeInsets.only(right: 3),
            child: Text(
              'edited',
              style: appBubbleTextStyle(
                context,
                color: metaColor,
                fontSize: AppFontSizes.caption,
                fontWeight: fontWeight,
              ),
            ),
          ),
        Text(
          timeText,
          style: appBubbleTextStyle(
            context,
            color: metaColor,
            fontSize: AppFontSizes.caption,
            fontWeight: fontWeight,
          ),
        ),
        if (showDeliveryStatus && deliveryIndicator != null) ...[
          const SizedBox(width: _statusIconGap),
          deliveryIndicator,
        ],
      ],
    );
  }
}
