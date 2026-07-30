import 'package:chahua/core/network/api_config.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/media/presentation/attachment_viewer_request.dart';
import 'package:chahua/features/conversation/timeline/model/conversation_message_highlight.dart';
import 'package:chahua/features/shared/presentation/app_avatar.dart';
import 'package:chahua/features/shared/model/message/message.dart'
    hide MessageItem;
import 'package:flutter/foundation.dart';
import 'package:flutter/cupertino.dart';

import '../../timeline/model/message_long_press_details_v2.dart';
import '../../timeline/presentation/reply_swipe_action_v2.dart';
import 'message_item.dart';

@visibleForTesting
const messageRowHighlightKey = ValueKey<String>('message-row-highlight');

@visibleForTesting
const messageRowFailedActionKey = ValueKey<String>('message-row-failed-action');

@visibleForTesting
const messageRowForwardSelectionIndicatorKey = ValueKey<String>(
  'message-row-forward-selection-indicator',
);

@visibleForTesting
const messageRowForwardSelectionCheckmarkKey = ValueKey<String>(
  'message-row-forward-selection-checkmark',
);

const double _bottomSpacing = 12;
const double _avatarSlotWidth = 36;
const double _avatarGap = 8;
const double _failedActionGap = 6;
const double _failedActionSize = 28;
const double _forwardSelectionSlotWidth = 36;
const double _forwardSelectionIndicatorSize = 22;

/// Private bubble layout alignment
enum _BubbleLayout { centered, aligned }

class MessageRowV2 extends StatefulWidget {
  const MessageRowV2({
    super.key,
    required this.message,
    this.highlight,
    this.onLongPress,
    this.onReply,
    this.onToggleReaction,
    this.onTapReply,
    this.onOpenThread,
    this.onOpenAttachment,
    this.onOpenSticker,
    this.onFailedMessageAction,
    this.isForwardSelectionMode = false,
    this.isForwardSelectionEnabled = true,
    this.isForwardSelected = false,
    this.onToggleForwardSelected,
    this.onForwardSelectionRejected,
    this.showSenderName = true,
    this.showAvatar = true,
    this.showDeliveryStatus = true,
  });

  final ConversationMessageV2 message;
  final ConversationMessageHighlight? highlight;
  final ValueChanged<MessageLongPressDetailsV2>? onLongPress;
  final VoidCallback? onReply;
  final ValueChanged<String>? onToggleReaction;
  final VoidCallback? onTapReply;
  final VoidCallback? onOpenThread;
  final ValueChanged<MessageAttachmentOpenRequest>? onOpenAttachment;
  final ValueChanged<String>? onOpenSticker;
  final ValueChanged<ConversationMessageV2>? onFailedMessageAction;
  final bool isForwardSelectionMode;
  final bool isForwardSelectionEnabled;
  final bool isForwardSelected;
  final VoidCallback? onToggleForwardSelected;
  final VoidCallback? onForwardSelectionRejected;
  final bool showSenderName;
  final bool showAvatar;
  final bool showDeliveryStatus;

  @override
  State<MessageRowV2> createState() => _MessageRowV2State();
}

class _MessageRowV2State extends State<MessageRowV2>
    with SingleTickerProviderStateMixin {
  final GlobalKey _bubbleKey = GlobalKey();
  late final AnimationController _highlightController = AnimationController(
    vsync: this,
    duration: ConversationMessageHighlight.totalDuration,
  );
  ConversationMessageHighlight? _activeHighlight;

  bool get _isMe => widget.message.sender.uid == ApiSession.currentUserId;
  bool get _showsFailedAction =>
      _isMe &&
      widget.message.serverMessageId == null &&
      widget.message.deliveryState == ConversationDeliveryState.failed &&
      widget.onFailedMessageAction != null;
  bool get _canReply =>
      widget.onReply != null &&
      !widget.message.isDeleted &&
      switch (widget.message.content) {
        TextMessageContent() ||
        AudioMessageContent() ||
        StickerMessageContent() ||
        InviteMessageContent() ||
        ForwardedPreviewContent() => true,
        SystemMessageContent() => false,
      };
  bool get _isDesktopPlatform {
    switch (defaultTargetPlatform) {
      case TargetPlatform.windows:
      case TargetPlatform.linux:
      case TargetPlatform.macOS:
        return true;
      case TargetPlatform.android:
      case TargetPlatform.iOS:
      case TargetPlatform.fuchsia:
        return false;
    }
  }

  @override
  void initState() {
    super.initState();
    _syncHighlight();
  }

  @override
  void didUpdateWidget(covariant MessageRowV2 oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncHighlight();
  }

  @override
  void dispose() {
    _highlightController.dispose();
    super.dispose();
  }

  void _syncHighlight() {
    final highlight = widget.highlight;
    if (highlight == null) {
      _activeHighlight = null;
      _highlightController.stop();
      _highlightController.value = 1;
      return;
    }
    if (_activeHighlight?.stableKey == highlight.stableKey &&
        _activeHighlight?.generation == highlight.generation) {
      return;
    }
    _activeHighlight = highlight;
    _highlightController.value = highlight.animationProgress(DateTime.now());
    _highlightController.forward();
  }

  Color _resolveHighlightColor(BuildContext context, double progress) {
    final highlight = _activeHighlight;
    if (highlight == null) {
      return CupertinoColors.transparent;
    }
    final elapsed = ConversationMessageHighlight.totalDuration * progress;
    final opacity = highlight.opacityAt(highlight.startedAt.add(elapsed));
    final highlightColor = context.appColors.chatMessageHighlight;
    return highlightColor.withValues(alpha: highlightColor.a * opacity);
  }

  _BubbleLayout _getBubbleLayout() {
    return switch (widget.message.content) {
      SystemMessageContent() => _BubbleLayout.centered,
      _ => _BubbleLayout.aligned,
    };
  }

  void _handleLongPress() {
    final context = _bubbleKey.currentContext;
    if (widget.onLongPress == null || context == null) {
      return;
    }
    final renderBox = context.findRenderObject() as RenderBox?;
    if (renderBox == null || !renderBox.attached) {
      return;
    }
    final origin = renderBox.localToGlobal(Offset.zero);
    widget.onLongPress!(
      MessageLongPressDetailsV2(
        message: widget.message,
        bubbleRect: origin & renderBox.size,
        isMe: _isMe,
        sourceShowsSenderName: widget.showSenderName,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final timelineViewportWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : null;
        final item = MessageItem(
          key: _bubbleKey,
          message: widget.message,
          isMe: _isMe,
          isInteractive: true,
          showSenderName: widget.showSenderName,
          showDeliveryStatus: widget.showDeliveryStatus,
          timelineViewportWidth: timelineViewportWidth,
          onToggleReaction: widget.onToggleReaction,
          onTapReply: widget.onTapReply,
          onOpenThread: widget.onOpenThread,
          onOpenAttachment: widget.onOpenAttachment,
          onOpenSticker: widget.onOpenSticker,
        );

        // NOTE: Early return here!!!
        if (_getBubbleLayout() == _BubbleLayout.centered) {
          return item;
        }

        final avatar = Padding(
          padding: const EdgeInsets.symmetric(horizontal: _avatarGap),
          child: widget.showAvatar
              ? AppAvatar(
                  imageUrl: widget.message.sender.avatarUrl,
                  size: _avatarSlotWidth,
                  name: widget.message.sender.name,
                )
              : const SizedBox.square(dimension: _avatarSlotWidth),
        );
        final failedAction = _showsFailedAction
            ? _FailedMessageActionButton(
                onPressed: () => widget.onFailedMessageAction!(widget.message),
              )
            : null;

        return GestureDetector(
          behavior: HitTestBehavior.translucent,
          onTap: widget.isForwardSelectionMode
              ? widget.isForwardSelectionEnabled
                    ? widget.onToggleForwardSelected
                    : widget.onForwardSelectionRejected
              : null,
          onLongPress: widget.isForwardSelectionMode || _isDesktopPlatform
              ? null
              : _handleLongPress,
          onSecondaryTapUp: widget.isForwardSelectionMode || !_isDesktopPlatform
              ? null
              : (_) => _handleLongPress(),
          child: Padding(
            padding: const EdgeInsets.only(bottom: _bottomSpacing),
            child: ReplySwipeActionV2(
              enabled: !widget.isForwardSelectionMode && _canReply,
              onTriggered: widget.onReply,
              child: AnimatedBuilder(
                animation: _highlightController,
                builder: (context, child) {
                  return DecoratedBox(
                    key: messageRowHighlightKey,
                    decoration: BoxDecoration(
                      color: _resolveHighlightColor(
                        context,
                        _highlightController.value,
                      ),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: child,
                  );
                },
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment
                      .end, // Important for tall message to align avatar at bottom
                  children: [
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      curve: Curves.easeOutCubic,
                      width: widget.isForwardSelectionMode
                          ? _forwardSelectionSlotWidth
                          : 0,
                      alignment: Alignment.center,
                      child: widget.isForwardSelectionMode
                          ? _ForwardSelectionIndicator(
                              isSelected: widget.isForwardSelected,
                              isEnabled: widget.isForwardSelectionEnabled,
                            )
                          : const SizedBox.shrink(),
                    ),
                    Expanded(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        textDirection: _isMe
                            ? TextDirection.rtl
                            : TextDirection.ltr,
                        children: [
                          avatar,
                          Flexible(child: item),
                          if (failedAction != null) ...[
                            const SizedBox(width: _failedActionGap),
                            failedAction,
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _ForwardSelectionIndicator extends StatelessWidget {
  const _ForwardSelectionIndicator({
    required this.isSelected,
    required this.isEnabled,
  });

  final bool isSelected;
  final bool isEnabled;

  @override
  Widget build(BuildContext context) {
    final accentColor = context.appColors.accentPrimary;
    final borderColor = isEnabled
        ? CupertinoColors.systemGrey3.resolveFrom(context)
        : CupertinoColors.systemGrey.resolveFrom(context);
    return AnimatedContainer(
      key: messageRowForwardSelectionIndicatorKey,
      duration: const Duration(milliseconds: 140),
      curve: Curves.easeOutCubic,
      width: _forwardSelectionIndicatorSize,
      height: _forwardSelectionIndicatorSize,
      decoration: BoxDecoration(
        color: isSelected
            ? accentColor
            : isEnabled
            ? CupertinoColors.transparent
            : CupertinoColors.systemGrey5.resolveFrom(context),
        shape: BoxShape.circle,
        border: Border.all(
          color: isSelected ? accentColor : borderColor,
          width: 1.5,
        ),
      ),
      alignment: Alignment.center,
      child: !isEnabled
          ? const Icon(
              CupertinoIcons.lock_fill,
              key: ValueKey<String>('message-row-forward-selection-lock'),
              size: 12,
              color: CupertinoColors.systemGrey,
            )
          : AnimatedSwitcher(
              duration: const Duration(milliseconds: 120),
              child: isSelected
                  ? const Icon(
                      CupertinoIcons.checkmark,
                      key: messageRowForwardSelectionCheckmarkKey,
                      size: 15,
                      color: CupertinoColors.white,
                    )
                  : const SizedBox.shrink(),
            ),
    );
  }
}

class _FailedMessageActionButton extends StatelessWidget {
  const _FailedMessageActionButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton(
      key: messageRowFailedActionKey,
      minimumSize: Size.zero,
      padding: EdgeInsets.zero,
      onPressed: onPressed,
      child: Container(
        width: _failedActionSize,
        height: _failedActionSize,
        decoration: BoxDecoration(
          color: CupertinoColors.systemRed.resolveFrom(context),
          shape: BoxShape.circle,
        ),
        alignment: Alignment.center,
        child: const Icon(
          CupertinoIcons.exclamationmark,
          size: 18,
          color: CupertinoColors.white,
        ),
      ),
    );
  }
}
