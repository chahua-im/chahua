import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/media/presentation/attachment_viewer_request.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/presentation/conversation_presentation_scope.dart';
import 'package:flutter/cupertino.dart';

import '../../domain/bubble_theme_v2.dart';
import '../parts/attachment/bubble_attachment_section.dart';
import '../parts/linkified_text.dart';
import '../parts/meta_footer.dart';
import '../parts/reply_quote.dart';
import '../parts/sender_header.dart';
import '../parts/thread_indicator.dart';
import 'text_bubble_v2.dart';

class TextBubblePlainContent extends StatelessWidget {
  const TextBubblePlainContent({
    super.key,
    required this.message,
    required this.theme,
    required this.showSenderName,
    this.onTapReply,
    this.onOpenThread,
    this.onOpenAttachment,
  });

  final ConversationMessageV2 message;
  final BubbleThemeV2 theme;
  final bool showSenderName;
  final VoidCallback? onTapReply;
  final VoidCallback? onOpenThread;
  final ValueChanged<MessageAttachmentOpenRequest>? onOpenAttachment;

  @override
  Widget build(BuildContext context) {
    final isThreadView =
        ConversationPresentationScope.maybeOf(context)?.isThreadView ?? false;
    final attachments = attachmentsForBubble(message.content);
    final hasAttachments = attachments.isNotEmpty;
    final children = <Widget>[];

    if (showSenderName) {
      children.add(
        SenderHeader(
          senderName: message.sender.name ?? 'User ${message.sender.uid}',
          gender: message.sender.gender,
        ),
      );
      children.add(const SizedBox(height: senderHeaderBodyGap));
    }

    if (message.replyToMessage != null) {
      children.add(
        ReplyQuote(reply: message.replyToMessage!, onTap: onTapReply),
      );
    }

    if (message.isDeleted) {
      if (children.isNotEmpty) {
        children.add(const SizedBox(height: 4));
      }
      children.add(
        Text(
          '[Deleted]',
          style: appBubbleTextStyle(
            context,
            color: theme.metaColor,
            fontSize: AppFontSizes.bodyLarge,
            fontStyle: FontStyle.italic,
            fontWeight: AppFontWeights.regular,
          ),
        ),
      );
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: children,
      );
    }

    if (hasAttachments) {
      if (children.isNotEmpty) {
        children.add(const SizedBox(height: 8));
      }
      children.add(
        BubbleAttachmentSection(
          attachments: attachments,
          messageStableKey: message.stableKey,
          theme: theme,
          variant: BubbleAttachmentSectionVariant.fileList,
          onOpenAttachment: onOpenAttachment,
        ),
      );
    }

    if (children.isNotEmpty &&
        (message.replyToMessage != null || hasAttachments)) {
      children.add(const SizedBox(height: 4));
    }
    children.add(TextBubbleMessageBody(message: message, theme: theme));

    final threadInfo = message.threadInfo;
    if (!isThreadView && threadInfo != null && threadInfo.replyCount > 0) {
      children.add(
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: ThreadIndicator(threadInfo: threadInfo, onTap: onOpenThread),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }
}

class TextBubbleMessageBody extends StatelessWidget {
  const TextBubbleMessageBody({
    super.key,
    required this.message,
    required this.theme,
  });

  final ConversationMessageV2 message;
  final BubbleThemeV2 theme;

  static const double _emptyBubbleMinWidth = 48;

  @override
  Widget build(BuildContext context) {
    final messageText = messageTextForBubble(message.content);
    final mentions = mentionsForBubble(message.content);
    final metaWidget = MetaFooter(message: message);

    if (messageText.trim().isEmpty) {
      return ConstrainedBox(
        constraints: BoxConstraints(
          minWidth: _emptyBubbleMinWidth,
          minHeight: theme.minBubbleContentHeight,
        ),
        child: Align(alignment: Alignment.bottomRight, child: metaWidget),
      );
    }

    return Align(
      alignment: Alignment.centerLeft,
      child: SizedBox(
        width: double.infinity,
        child: Stack(
          children: [
            LinkifiedText(
              text: messageText,
              textStyle: appBubbleTextStyle(
                context,
                color: theme.textColor,
                fontSize: theme.chatMessageFontSize,
                height: 1.28,
                fontWeight: AppFontWeights.medium,
                fontFamilyFallback: AppFontFamilies.cjkFallback,
              ),
              mentions: mentions,
              currentUserId: null,
            ),
            Positioned(right: 0, bottom: 0, child: metaWidget),
          ],
        ),
      ),
    );
  }
}
