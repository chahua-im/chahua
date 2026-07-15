import 'dart:developer';

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
    if (content is! ForwardedPreviewContent) {
      return const SizedBox.shrink();
    }

    final theme = BubbleThemeV2.of(context);
    final l10n = AppLocalizations.of(context)!;
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: theme.maxBubbleWidth),
      child: CupertinoButton(
        padding: EdgeInsets.zero,
        minimumSize: Size.zero,
        onPressed: () => _openForwardedViewer(context),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: theme.bubbleColor,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: theme.metaColor.withValues(alpha: theme.metaColor.a * 0.2),
            ),
          ),
          child: SizedBox(
            width: (theme.maxBubbleWidth * 0.4).clamp(
              220.0,
              theme.maxBubbleWidth,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: _ForwardedHistoryPreview(
                total: content.total,
                messages: content.previewMessages,
                theme: theme,
                l10n: l10n,
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openForwardedViewer(BuildContext context) {
    log(
      'open forwarded viewer chatId=${message.chatId} messageId=${message.serverMessageId}',
      name: 'ForwardedMessageCard',
    );
    final navigationBarBackgroundColor = CupertinoTheme.of(
      context,
    ).barBackgroundColor;
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (context) => ForwardedMessagesViewer(
          messages: const <ForwardedMessage>[],
          navigationBarBackgroundColor: navigationBarBackgroundColor,
        ),
      ),
    );
  }
}

class _ForwardedHistoryPreview extends StatelessWidget {
  const _ForwardedHistoryPreview({
    required this.total,
    required this.messages,
    required this.theme,
    required this.l10n,
  });

  final int total;
  final List<ForwardedMessagePreview> messages;
  final BubbleThemeV2 theme;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                l10n.forwardedChatHistoryTitle,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: appBubbleTextStyle(
                  context,
                  color: theme.textColor,
                  fontSize: AppFontSizes.body,
                  fontWeight: AppFontWeights.semibold,
                ),
              ),
              const SizedBox(height: 4),
              for (final message in messages) ...[
                _ForwardedPreviewLine(
                  message: message,
                  theme: theme,
                  l10n: l10n,
                ),
                const SizedBox(height: 4),
              ],
              Text(
                l10n.forwardedMessagesFooterCount(total),
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
        Icon(CupertinoIcons.chevron_forward, size: 18, color: theme.metaColor),
      ],
    );
  }
}

class _ForwardedPreviewLine extends StatelessWidget {
  const _ForwardedPreviewLine({
    required this.message,
    required this.theme,
    required this.l10n,
  });

  final ForwardedMessagePreview message;
  final BubbleThemeV2 theme;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final senderName = _senderName(message.sender, l10n);
    final preview = formatMessagePreview(
      message: message.message,
      messageType: message.messageType,
      firstAttachmentKind: message.firstAttachmentKind,
      mentions: message.mentions,
      l10n: l10n,
    );
    return Text(
      '$senderName: $preview',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: appBubbleTextStyle(
        context,
        color: theme.textColor,
        fontSize: AppFontSizes.body,
        fontWeight: AppFontWeights.regular,
      ),
    );
  }
}

String _senderName(User sender, AppLocalizations l10n) {
  final name = sender.name?.trim();
  if (name != null && name.isNotEmpty) {
    return name;
  }
  return l10n.userFallbackName(sender.uid);
}

class ForwardedMessagesViewer extends StatefulWidget {
  const ForwardedMessagesViewer({
    super.key,
    required this.messages,
    required this.navigationBarBackgroundColor,
  });

  final List<ForwardedMessage> messages;
  final Color navigationBarBackgroundColor;

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
    final colors = context.appColors;
    final l10n = AppLocalizations.of(context)!;
    return CupertinoPageScaffold(
      backgroundColor: colors.chatBackground,
      navigationBar: CupertinoNavigationBar(
        backgroundColor: widget.navigationBarBackgroundColor,
        automaticBackgroundVisibility: false,
        middle: Text(l10n.forwardedMessagesTitle),
      ),
      child: SafeArea(
        child: ListView.builder(
          padding: const EdgeInsets.fromLTRB(8, 12, 8, 24),
          itemCount: widget.messages.length,
          itemBuilder: (context, index) {
            final forwardedMessage = widget.messages[index];
            final message = _messageFromForwardedMessage(forwardedMessage);
            final replyToMessageId = message.replyToMessage?.id;
            return KeyedSubtree(
              key: _messageKeys[forwardedMessage.originalMessageId],
              child: MessageRowV2(
                message: message,
                showSenderName: _shouldShowSenderName(index),
                showAvatar: _shouldShowAvatar(index),
                showDeliveryStatus: false,
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

  bool _shouldShowSenderName(int index) {
    final forwardedMessage = widget.messages[index];
    if (forwardedMessage.content is SystemMessageContent) {
      return false;
    }

    final previousMessage = index > 0 ? widget.messages[index - 1] : null;
    return previousMessage == null ||
        previousMessage.content is SystemMessageContent ||
        previousMessage.sender.uid != forwardedMessage.sender.uid;
  }

  bool _shouldShowAvatar(int index) {
    final forwardedMessage = widget.messages[index];
    if (forwardedMessage.content is SystemMessageContent) {
      return false;
    }

    final nextMessage = index < widget.messages.length - 1
        ? widget.messages[index + 1]
        : null;
    return nextMessage == null ||
        nextMessage.content is SystemMessageContent ||
        nextMessage.sender.uid != forwardedMessage.sender.uid;
  }

  ConversationMessageV2 _messageFromForwardedMessage(
    ForwardedMessage forwardedMessage,
  ) {
    return ConversationMessageV2(
      serverMessageId: forwardedMessage.originalMessageId,
      clientGeneratedId:
          'forwarded:${forwardedMessage.originalChatId}:${forwardedMessage.originalMessageId}',
      sender: forwardedMessage.sender,
      createdAt: forwardedMessage.originalCreatedAt,
      replyToMessage: forwardedMessage.replyToMessage,
      content: forwardedMessage.content,
    );
  }
}
