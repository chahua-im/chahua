import 'package:chahua/features/shared/presentation/chat_timestamp_formatter.dart';
import 'package:flutter/cupertino.dart';

@visibleForTesting
const conversationDateSeparatorLabelKey = ValueKey<String>(
  'conversation-date-separator-label',
);

@visibleForTesting
const conversationFloatingDateLabelKey = ValueKey<String>(
  'conversation-floating-date-label',
);

class ConversationDateSeparator extends StatelessWidget {
  const ConversationDateSeparator({super.key, required this.day});

  final DateTime day;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 8),
      child: Center(
        child: ConversationDateLabel(
          day: day,
          labelKey: conversationDateSeparatorLabelKey,
        ),
      ),
    );
  }
}

class ConversationFloatingDate extends StatelessWidget {
  const ConversationFloatingDate({
    super.key,
    required this.day,
    required this.visible,
  });

  final DateTime day;
  final bool visible;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 12,
      left: 0,
      right: 0,
      child: IgnorePointer(
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          child: AnimatedSlide(
            offset: visible ? Offset.zero : const Offset(0, -0.2),
            duration: const Duration(milliseconds: 180),
            curve: Curves.easeOut,
            child: Center(
              child: ConversationDateLabel(
                day: day,
                labelKey: conversationFloatingDateLabelKey,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class ConversationDateLabel extends StatelessWidget {
  const ConversationDateLabel({super.key, required this.day, this.labelKey});

  final DateTime day;
  final Key? labelKey;

  @override
  Widget build(BuildContext context) {
    final backgroundColor = CupertinoDynamicColor.resolve(
      CupertinoColors.systemFill,
      context,
    );
    final foregroundColor = CupertinoDynamicColor.resolve(
      CupertinoColors.secondaryLabel,
      context,
    );

    return DecoratedBox(
      decoration: BoxDecoration(
        color: backgroundColor,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        child: Text(
          formatDateSeparator(context, day),
          key: labelKey,
          style: TextStyle(
            color: foregroundColor,
            fontSize: 13,
            fontWeight: FontWeight.w500,
            letterSpacing: 0,
          ),
        ),
      ),
    );
  }
}
