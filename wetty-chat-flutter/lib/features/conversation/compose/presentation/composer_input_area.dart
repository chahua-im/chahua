import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show CircularProgressIndicator;

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/compose/data/attachment_picker_service.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_composer_view_model.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_audio_controls.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_content_row.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';

class ComposerInputArea extends StatelessWidget {
  const ComposerInputArea({
    super.key,
    required this.composer,
    required this.textController,
    required this.focusNode,
    required this.inputScrollController,
    required this.snapPosition,
    required this.fieldMinHeight,
    required this.onDraftChanged,
    required this.onSend,
    required this.onRemoveAttachment,
    required this.onRetryAttachment,
    required this.onDeleteAudioDraft,
    this.onToggleStickerPicker,
    this.isStickerPickerOpen = false,
  });

  final ConversationComposerState composer;
  final TextEditingController textController;
  final FocusNode focusNode;
  final ScrollController inputScrollController;
  final ComposerAudioSnapPosition snapPosition;
  final double fieldMinHeight;
  final ValueChanged<String> onDraftChanged;
  final Future<void> Function() onSend;
  final ValueChanged<String> onRemoveAttachment;
  final Future<void> Function(String localId) onRetryAttachment;
  final Future<void> Function() onDeleteAudioDraft;
  final VoidCallback? onToggleStickerPicker;
  final bool isStickerPickerOpen;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (composer.attachments.isNotEmpty)
          _ComposerAttachmentPreview(
            attachments: composer.attachments,
            onRemoveAttachment: onRemoveAttachment,
            onRetryAttachment: onRetryAttachment,
          ),
        ComposerContentRow(
          composer: composer,
          textController: textController,
          focusNode: focusNode,
          inputScrollController: inputScrollController,
          snapPosition: snapPosition,
          fieldMinHeight: fieldMinHeight,
          onDraftChanged: onDraftChanged,
          onSend: onSend,
          onDeleteAudioDraft: onDeleteAudioDraft,
          onToggleStickerPicker: onToggleStickerPicker,
          isStickerPickerOpen: isStickerPickerOpen,
          onTextFieldTap: isStickerPickerOpen ? onToggleStickerPicker : null,
        ),
      ],
    );
  }
}

class ComposerPreviewBar extends StatelessWidget {
  const ComposerPreviewBar({
    super.key,
    required this.composer,
    required this.onClearMode,
  });

  final ConversationComposerState composer;
  final VoidCallback onClearMode;

  @override
  Widget build(BuildContext context) {
    final mode = composer.mode;
    final l10n = AppLocalizations.of(context)!;
    return switch (mode) {
      ComposerReplying(:final message) => _PreviewBar(
        title:
            '${l10n.reply} ${message.sender.name ?? l10n.userFallbackName(message.sender.uid)}',
        body: _formatMessagePreview(message, l10n),
        onClearMode: onClearMode,
      ),
      ComposerEditing(:final message) => _PreviewBar(
        title: l10n.edit,
        body: _formatMessagePreview(message, l10n),
        onClearMode: onClearMode,
      ),
      ComposerIdle() => const SizedBox.shrink(),
    };
  }

  String _formatMessagePreview(
    ConversationMessageV2 message,
    AppLocalizations l10n,
  ) {
    final attachments = _previewAttachmentsFor(message.content);
    return formatMessagePreview(
      message: _previewTextFor(message.content),
      messageType: _previewMessageTypeFor(message.content),
      sticker: _previewStickerFor(message.content),
      attachments: attachments,
      firstAttachmentKind: attachments.isNotEmpty
          ? attachments.first.kind
          : null,
      isDeleted: message.isDeleted,
      mentions: _previewMentionsFor(message.content),
      l10n: l10n,
    );
  }
}

String? _previewTextFor(MessageContent content) {
  return switch (content) {
    TextMessageContent(:final text) => text,
    AudioMessageContent(:final text) => text,
    InviteMessageContent(:final text) => text,
    SystemMessageContent(:final text) => text,
    StickerMessageContent() => null,
    ForwardedMessageContent() => null,
  };
}

String _previewMessageTypeFor(MessageContent content) {
  return switch (content) {
    TextMessageContent() => 'text',
    AudioMessageContent() => 'audio',
    InviteMessageContent() => 'invite',
    StickerMessageContent() => 'sticker',
    SystemMessageContent() => 'system',
    ForwardedMessageContent() => 'forwarded',
  };
}

StickerSummary? _previewStickerFor(MessageContent content) {
  return switch (content) {
    StickerMessageContent(:final sticker) => sticker,
    _ => null,
  };
}

List<AttachmentItem> _previewAttachmentsFor(MessageContent content) {
  return switch (content) {
    AudioMessageContent(:final audio) => [audio],
    TextMessageContent(:final attachments) => attachments,
    _ => const <AttachmentItem>[],
  };
}

List<MentionInfo> _previewMentionsFor(MessageContent content) {
  return switch (content) {
    TextMessageContent(:final mentions) => mentions,
    AudioMessageContent(:final mentions) => mentions,
    InviteMessageContent(:final mentions) => mentions,
    _ => const <MentionInfo>[],
  };
}

class _PreviewBar extends StatelessWidget {
  const _PreviewBar({
    required this.title,
    required this.body,
    required this.onClearMode,
  });

  final String title;
  final String body;
  final VoidCallback onClearMode;

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 6, 8, 4),
      decoration: BoxDecoration(
        color: colors.composerReplyPreviewSurface,
        border: Border(
          bottom: BorderSide(color: colors.composerReplyPreviewDivider),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: appTextStyle(
                    context,
                    fontWeight: AppFontWeights.semibold,
                    fontSize: AppFontSizes.meta,
                    color: colors.composerReplyPreviewTitle,
                  ),
                ),
                const SizedBox(height: 1),
                Text(
                  body,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: appSecondaryTextStyle(
                    context,
                    fontSize: AppFontSizes.meta,
                  ),
                ),
              ],
            ),
          ),
          CupertinoButton(
            padding: EdgeInsets.zero,
            minimumSize: const Size(30, 30),
            onPressed: onClearMode,
            child: Icon(
              CupertinoIcons.xmark_circle_fill,
              size: 18,
              color: colors.inactive,
            ),
          ),
        ],
      ),
    );
  }
}

class _ComposerAttachmentPreview extends StatelessWidget {
  const _ComposerAttachmentPreview({
    required this.attachments,
    required this.onRemoveAttachment,
    required this.onRetryAttachment,
  });

  final List<ComposerAttachment> attachments;
  final ValueChanged<String> onRemoveAttachment;
  final Future<void> Function(String localId) onRetryAttachment;

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.inputBorder)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final attachment in attachments)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: _AttachmentCard(
                  attachment: attachment,
                  onRemove: () => onRemoveAttachment(attachment.localId),
                  onRetry: () =>
                      unawaited(onRetryAttachment(attachment.localId)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AttachmentCard extends StatelessWidget {
  const _AttachmentCard({
    required this.attachment,
    required this.onRemove,
    required this.onRetry,
  });

  static const double _fallbackExtent = 116;
  static const double _maxVisualWidth = 180;
  static const double _maxVisualHeight = 116;

  final ComposerAttachment attachment;
  final VoidCallback onRemove;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final borderColor = CupertinoColors.systemGrey4.resolveFrom(context);
    final previewSize = _previewSizeFor(attachment);
    return Container(
      key: ValueKey('composer-attachment-card-${attachment.localId}'),
      width: previewSize.width,
      height: previewSize.height,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: borderColor),
        boxShadow: [
          BoxShadow(
            color: CupertinoColors.black.withAlpha(26),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          _AttachmentPreviewThumb(attachment: attachment),
          Positioned(
            top: 6,
            right: 6,
            child: CupertinoButton(
              padding: EdgeInsets.zero,
              minimumSize: const Size(28, 28),
              onPressed: onRemove,
              child: Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(
                  color: CupertinoColors.black.withAlpha(150),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  CupertinoIcons.xmark,
                  size: 16,
                  color: CupertinoColors.white,
                ),
              ),
            ),
          ),
          if (attachment.isQueued || attachment.isUploading)
            _ProgressOverlay(attachment: attachment)
          else if (attachment.isFailed)
            _ErrorOverlay(attachment: attachment, onRetry: onRetry),
        ],
      ),
    );
  }

  static Size _previewSizeFor(ComposerAttachment attachment) {
    if (!_usesVisualPreview(attachment) ||
        attachment.width == null ||
        attachment.height == null ||
        attachment.width! <= 0 ||
        attachment.height! <= 0) {
      return const Size(_fallbackExtent, _fallbackExtent);
    }

    final aspectRatio = attachment.width! / attachment.height!;
    var resolvedWidth = attachment.width!.toDouble();
    var resolvedHeight = attachment.height!.toDouble();

    if (resolvedHeight > _maxVisualHeight) {
      resolvedHeight = _maxVisualHeight;
      resolvedWidth = resolvedHeight * aspectRatio;
    }

    if (resolvedWidth > _maxVisualWidth) {
      resolvedWidth = _maxVisualWidth;
      resolvedHeight = resolvedWidth / aspectRatio;
    }

    resolvedWidth = math.max(resolvedWidth, 1);
    resolvedHeight = math.max(resolvedHeight, 1);
    return Size(resolvedWidth, resolvedHeight);
  }

  static bool _usesVisualPreview(ComposerAttachment attachment) {
    return attachment.kind == ComposerAttachmentKind.image ||
        attachment.kind == ComposerAttachmentKind.gif ||
        attachment.kind == ComposerAttachmentKind.video;
  }
}

class _AttachmentPreviewThumb extends StatelessWidget {
  const _AttachmentPreviewThumb({required this.attachment});

  final ComposerAttachment attachment;

  @override
  Widget build(BuildContext context) {
    final background = CupertinoColors.systemGrey4.resolveFrom(context);
    final icon = switch (attachment.kind) {
      ComposerAttachmentKind.video => CupertinoIcons.play_rectangle_fill,
      _ => CupertinoIcons.photo_fill,
    };

    if (attachment.previewBytes != null) {
      return Stack(
        fit: StackFit.expand,
        children: [
          Image.memory(attachment.previewBytes!, fit: BoxFit.cover),
          if (attachment.kind == ComposerAttachmentKind.video)
            Container(color: CupertinoColors.black.withAlpha(36)),
          if (attachment.kind == ComposerAttachmentKind.video)
            const Center(
              child: Icon(
                CupertinoIcons.play_fill,
                color: CupertinoColors.white,
                size: 28,
              ),
            ),
        ],
      );
    }

    return DecoratedBox(
      decoration: BoxDecoration(color: background),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 32, color: CupertinoColors.white),
              const SizedBox(height: 8),
              Text(
                attachment.name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: appTextStyle(
                  context,
                  fontSize: AppFontSizes.meta,
                  color: CupertinoColors.white,
                  fontWeight: AppFontWeights.semibold,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProgressOverlay extends StatelessWidget {
  const _ProgressOverlay({required this.attachment});

  final ComposerAttachment attachment;

  @override
  Widget build(BuildContext context) {
    final progressValue = attachment.progress > 0 ? attachment.progress : null;
    final progressLabel = '${(attachment.progress * 100).round()}%';
    return Container(
      color: CupertinoColors.black.withAlpha(135),
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 54,
            height: 54,
            child: Stack(
              alignment: Alignment.center,
              children: [
                CircularProgressIndicator(
                  value: progressValue,
                  strokeWidth: 3,
                  valueColor: const AlwaysStoppedAnimation<Color>(
                    CupertinoColors.white,
                  ),
                  backgroundColor: CupertinoColors.white.withAlpha(64),
                ),
                Text(
                  progressValue == null ? '...' : progressLabel,
                  style: appTextStyle(
                    context,
                    fontSize: AppFontSizes.meta,
                    color: CupertinoColors.white,
                    fontWeight: AppFontWeights.semibold,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ErrorOverlay extends StatelessWidget {
  const _ErrorOverlay({required this.attachment, required this.onRetry});

  final ComposerAttachment attachment;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xC27F1D1D),
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            CupertinoIcons.exclamationmark_circle_fill,
            size: 28,
            color: CupertinoColors.white,
          ),
          const SizedBox(height: 8),
          Text(
            attachment.errorMessage ?? 'Upload failed',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: appTextStyle(
              context,
              fontSize: AppFontSizes.meta,
              color: CupertinoColors.white,
              fontWeight: AppFontWeights.semibold,
            ),
          ),
          const SizedBox(height: 8),
          CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            minimumSize: const Size(28, 28),
            color: CupertinoColors.white.withAlpha(36),
            borderRadius: BorderRadius.circular(999),
            onPressed: onRetry,
            child: Text(
              'Retry',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.meta,
                color: CupertinoColors.white,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
