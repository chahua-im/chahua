import 'dart:developer';

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
        onPressed: () => _openForwardedViewer(context, content),
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

  void _openForwardedViewer(
    BuildContext context,
    ForwardedPreviewContent content,
  ) {
    final chatId = message.chatId;
    final messageId = message.serverMessageId;
    final forwardedBundleId = content.forwardedBundleId;
    if (chatId == null || messageId == null || forwardedBundleId == null) {
      log(
        'missing forwarded viewer identity chatId=$chatId '
        'messageId=$messageId forwardedBundleId=$forwardedBundleId',
        name: 'ForwardedMessageCard',
      );
      return;
    }
    final navigationBarBackgroundColor = CupertinoTheme.of(
      context,
    ).barBackgroundColor;
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (context) => ForwardedMessagesViewer(
          rootChatId: chatId,
          rootMessageId: messageId,
          forwardedBundleId: forwardedBundleId,
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
      attachmentKinds: message.attachmentKinds,
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

class ForwardedMessagesViewer extends ConsumerStatefulWidget {
  const ForwardedMessagesViewer({
    super.key,
    required this.rootChatId,
    required this.rootMessageId,
    required this.forwardedBundleId,
    required this.navigationBarBackgroundColor,
  });

  final int rootChatId;
  final int rootMessageId;
  final String forwardedBundleId;
  final Color navigationBarBackgroundColor;

  @override
  ConsumerState<ForwardedMessagesViewer> createState() =>
      _ForwardedMessagesViewerState();
}

class _ForwardedMessagesViewerState
    extends ConsumerState<ForwardedMessagesViewer> {
  final Map<int, GlobalKey> _messageKeys = {};

  GlobalKey _keyForMessage(int messageId) {
    return _messageKeys.putIfAbsent(messageId, GlobalKey.new);
  }

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
    final forwardedMessages = ref.watch(
      forwardedMessagesProvider((
        rootChatId: widget.rootChatId,
        rootMessageId: widget.rootMessageId,
        forwardedBundleId: widget.forwardedBundleId,
      )),
    );
    return CupertinoPageScaffold(
      backgroundColor: colors.chatBackground,
      navigationBar: CupertinoNavigationBar(
        backgroundColor: widget.navigationBarBackgroundColor,
        automaticBackgroundVisibility: false,
        middle: Text(l10n.forwardedMessagesTitle),
      ),
      child: SafeArea(
        child: forwardedMessages.when(
          loading: () => const Center(child: CupertinoActivityIndicator()),
          error: (_, _) => const Center(
            child: Icon(CupertinoIcons.exclamationmark_triangle),
          ),
          data: (response) {
            final messages = response.messages
                .map(ForwardedMessage.fromDto)
                .toList(growable: false);
            return _ForwardedMessagesList(
              messages: messages,
              rootChatId: widget.rootChatId,
              rootMessageId: widget.rootMessageId,
              keyForMessage: _keyForMessage,
              jumpToMessage: _jumpToMessage,
            );
          },
        ),
      ),
    );
  }
}

class _ForwardedMessagesList extends StatelessWidget {
  const _ForwardedMessagesList({
    required this.messages,
    required this.rootChatId,
    required this.rootMessageId,
    required this.keyForMessage,
    required this.jumpToMessage,
  });

  final List<ForwardedMessage> messages;
  final int rootChatId;
  final int rootMessageId;
  final GlobalKey Function(int messageId) keyForMessage;
  final void Function(int messageId) jumpToMessage;

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(8, 12, 8, 24),
      itemCount: messages.length,
      itemBuilder: (context, index) {
        final forwardedMessage = messages[index];
        final message = _messageFromForwardedMessage(
          forwardedMessage,
          rootChatId: rootChatId,
          rootMessageId: rootMessageId,
        );
        final replyToMessageId = message.replyToMessage?.id;
        return KeyedSubtree(
          key: keyForMessage(forwardedMessage.originalMessageId),
          child: MessageRowV2(
            key: ValueKey(
              'forwarded-message-${forwardedMessage.originalChatId}-${forwardedMessage.originalMessageId}',
            ),
            message: message,
            showSenderName: _shouldShowSenderName(index),
            showAvatar: _shouldShowAvatar(index),
            showDeliveryStatus: false,
            onTapReply:
                replyToMessageId != null &&
                    messages.any(
                      (message) =>
                          message.originalMessageId == replyToMessageId,
                    )
                ? () => jumpToMessage(replyToMessageId)
                : null,
          ),
        );
      },
    );
  }

  bool _shouldShowSenderName(int index) {
    final forwardedMessage = messages[index];
    if (forwardedMessage.content is SystemMessageContent) {
      return false;
    }

    final previousMessage = index > 0 ? messages[index - 1] : null;
    return previousMessage == null ||
        previousMessage.content is SystemMessageContent ||
        previousMessage.sender.uid != forwardedMessage.sender.uid;
  }

  bool _shouldShowAvatar(int index) {
    final forwardedMessage = messages[index];
    if (forwardedMessage.content is SystemMessageContent) {
      return false;
    }

    final nextMessage = index < messages.length - 1
        ? messages[index + 1]
        : null;
    return nextMessage == null ||
        nextMessage.content is SystemMessageContent ||
        nextMessage.sender.uid != forwardedMessage.sender.uid;
  }

  ConversationMessageV2 _messageFromForwardedMessage(
    ForwardedMessage forwardedMessage, {
    required int rootChatId,
    required int rootMessageId,
  }) {
    return ConversationMessageV2(
      serverMessageId: rootMessageId,
      chatId: rootChatId,
      clientGeneratedId:
          'forwarded:${forwardedMessage.originalChatId}:${forwardedMessage.originalMessageId}',
      sender: forwardedMessage.sender,
      createdAt: forwardedMessage.originalCreatedAt,
      replyToMessage: forwardedMessage.replyToMessage,
      content: forwardedMessage.content,
    );
  }
}
