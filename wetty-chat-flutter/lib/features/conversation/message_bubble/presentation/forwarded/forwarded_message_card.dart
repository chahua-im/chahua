import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';

import '../../domain/bubble_theme_v2.dart';

class ForwardedMessageCard extends StatelessWidget {
  const ForwardedMessageCard({super.key, required this.message});

  final ConversationMessageV2 message;

  @override
  Widget build(BuildContext context) {
    final content = message.content;
    if (content is! ForwardedMessageContent) {
      debugPrint('not a forwarded message');
      return const SizedBox.shrink();
    }
    debugPrint('forwarded message: ${content.messages}');

    final theme = BubbleThemeV2.of(context);
    final l10n = AppLocalizations.of(context)!;
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: theme.maxBubbleWidth),
      child: CupertinoButton(
        padding: EdgeInsets.zero,
        minimumSize: Size.zero,
        onPressed: () => _openForwardedViewer(context, content.messages),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: theme.bubbleColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: theme.metaColor.withValues(alpha: theme.metaColor.a * 0.2),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  CupertinoIcons.arrowshape_turn_up_right,
                  size: 20,
                  color: theme.metaColor,
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        l10n.forwardedMessagesTitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: appBubbleTextStyle(
                          context,
                          color: theme.textColor,
                          fontSize: AppFontSizes.body,
                          fontWeight: AppFontWeights.semibold,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        l10n.forwardedMessagesCount(content.messages.length),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: appBubbleMetaTextStyle(
                          context,
                          color: theme.metaColor,
                          fontSize: AppFontSizes.caption,
                          fontWeight: AppFontWeights.regular,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Icon(
                  CupertinoIcons.chevron_forward,
                  size: 18,
                  color: theme.metaColor,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _openForwardedViewer(
    BuildContext context,
    List<ForwardedMessageSnapshot> messages,
  ) {
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (context) => ForwardedMessagesViewer(messages: messages),
      ),
    );
  }
}

class ForwardedMessagesViewer extends StatefulWidget {
  const ForwardedMessagesViewer({super.key, required this.messages});

  final List<ForwardedMessageSnapshot> messages;

  @override
  State<ForwardedMessagesViewer> createState() =>
      _ForwardedMessagesViewerState();
}

class _ForwardedMessagesViewerState extends State<ForwardedMessagesViewer> {
  late final Map<int, GlobalKey> _messageKeys = {
    for (final message in widget.messages)
      message.originalMessageId: GlobalKey(),
  };

  void _jumpToMessage(int messageId) {
    final keyContext = _messageKeys[messageId]?.currentContext;
    if (keyContext == null) {
      return;
    }
    Scrollable.ensureVisible(
      keyContext,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
      alignment: 0.35,
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(l10n.forwardedMessagesTitle),
      ),
      child: SafeArea(
        child: ListView.builder(
          padding: const EdgeInsets.fromLTRB(8, 12, 8, 24),
          itemCount: widget.messages.length,
          itemBuilder: (context, index) {
            final snapshot = widget.messages[index];
            final message = _messageFromSnapshot(snapshot);
            final replyToMessageId = message.replyToMessage?.id;
            return KeyedSubtree(
              key: _messageKeys[snapshot.originalMessageId],
              child: MessageRowV2(
                message: message,
                showSenderName: true,
                showAvatar: true,
                onTapReply:
                    replyToMessageId != null &&
                        _messageKeys.containsKey(replyToMessageId)
                    ? () => _jumpToMessage(replyToMessageId)
                    : null,
              ),
            );
          },
        ),
      ),
    );
  }

  ConversationMessageV2 _messageFromSnapshot(
    ForwardedMessageSnapshot snapshot,
  ) {
    return ConversationMessageV2(
      serverMessageId: snapshot.originalMessageId,
      clientGeneratedId:
          'forwarded:${snapshot.originalChatId}:${snapshot.originalMessageId}',
      sender: snapshot.sender,
      createdAt: snapshot.originalCreatedAt,
      replyToMessage: snapshot.replyToMessage,
      content: snapshot.content,
    );
  }
}
