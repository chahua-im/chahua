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
          child: SizedBox(
            width: (theme.maxBubbleWidth * 0.4).clamp(
              220.0,
              theme.maxBubbleWidth,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              child: _ForwardedHistoryPreview(
                messages: content.messages,
                theme: theme,
                l10n: l10n,
              ),
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
    final navigationBarBackgroundColor = CupertinoTheme.of(
      context,
    ).barBackgroundColor;
    debugPrint('navigationBarBackgroundColor: $navigationBarBackgroundColor');
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (context) => ForwardedMessagesViewer(
          messages: messages,
          navigationBarBackgroundColor: navigationBarBackgroundColor,
        ),
      ),
    );
  }
}

class _ForwardedHistoryPreview extends StatelessWidget {
  const _ForwardedHistoryPreview({
    required this.messages,
    required this.theme,
    required this.l10n,
  });

  static const int _previewLimit = 3;

  final List<ForwardedMessageSnapshot> messages;
  final BubbleThemeV2 theme;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final previewMessages = messages.take(_previewLimit);
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
              for (final message in previewMessages) ...[
                _ForwardedPreviewLine(
                  message: message,
                  theme: theme,
                  l10n: l10n,
                ),
                const SizedBox(height: 4),
              ],
              Text(
                l10n.forwardedMessagesFooterCount(messages.length),
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

  final ForwardedMessageSnapshot message;
  final BubbleThemeV2 theme;
  final AppLocalizations l10n;

  @override
  Widget build(BuildContext context) {
    final senderName = _senderName(message.sender, l10n);
    final preview = _messagePreview(message.content, l10n);
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

String _messagePreview(MessageContent content, AppLocalizations l10n) {
  return switch (content) {
    TextMessageContent(:final text, :final attachments, :final mentions) =>
      formatMessagePreview(
        message: text,
        messageType: 'text',
        attachments: attachments,
        mentions: mentions,
        l10n: l10n,
      ),
    AudioMessageContent(:final text, :final mentions) => formatMessagePreview(
      message: text,
      messageType: 'audio',
      mentions: mentions,
      l10n: l10n,
    ),
    StickerMessageContent(:final sticker) => formatMessagePreview(
      messageType: 'sticker',
      sticker: sticker,
      l10n: l10n,
    ),
    InviteMessageContent(:final text, :final mentions) => formatMessagePreview(
      message: text,
      messageType: 'invite',
      mentions: mentions,
      l10n: l10n,
    ),
    ForwardedMessageContent() => formatMessagePreview(
      messageType: 'forwarded',
      l10n: l10n,
    ),
    SystemMessageContent(:final text) => formatMessagePreview(
      message: text,
      messageType: 'system',
      l10n: l10n,
    ),
  };
}

class ForwardedMessagesViewer extends StatefulWidget {
  const ForwardedMessagesViewer({
    super.key,
    required this.messages,
    required this.navigationBarBackgroundColor,
  });

  final List<ForwardedMessageSnapshot> messages;
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
            final snapshot = widget.messages[index];
            final message = _messageFromSnapshot(snapshot);
            final replyToMessageId = message.replyToMessage?.id;
            return KeyedSubtree(
              key: _messageKeys[snapshot.originalMessageId],
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
    final snapshot = widget.messages[index];
    if (snapshot.content is SystemMessageContent) {
      return false;
    }

    final previousSnapshot = index > 0 ? widget.messages[index - 1] : null;
    return previousSnapshot == null ||
        previousSnapshot.content is SystemMessageContent ||
        previousSnapshot.sender.uid != snapshot.sender.uid;
  }

  bool _shouldShowAvatar(int index) {
    final snapshot = widget.messages[index];
    if (snapshot.content is SystemMessageContent) {
      return false;
    }

    final nextSnapshot = index < widget.messages.length - 1
        ? widget.messages[index + 1]
        : null;
    return nextSnapshot == null ||
        nextSnapshot.content is SystemMessageContent ||
        nextSnapshot.sender.uid != snapshot.sender.uid;
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
