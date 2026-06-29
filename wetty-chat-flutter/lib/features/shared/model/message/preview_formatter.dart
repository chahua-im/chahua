import 'package:chahua/l10n/app_localizations.dart';

import 'attachment.dart';
import 'mention.dart';
import 'message_preview.dart';
import 'reply_to_message.dart';
import 'sticker.dart';

const String deletedPreviewLabel = '[Deleted]';
const String invitePreviewLabel = '[Invite]';
const String stickerPreviewLabel = '[Sticker]';
const String voiceMessagePreviewLabel = '[Voice message]';
const String imagePreviewLabel = '[Image]';
const String videoPreviewLabel = '[Video]';
const String attachmentPreviewLabel = '[Attachment]';
const String forwardedPreviewLabel = '[Forwarded]';

String formatReplyPreview(ReplyToMessage preview, {AppLocalizations? l10n}) {
  return formatMessagePreviewSummary(
    MessagePreview(
      messageId: preview.id,
      clientGeneratedId: null,
      sender: preview.sender,
      message: preview.message,
      messageType: preview.messageType,
      sticker: preview.sticker,
      attachments: preview.attachments,
      reactions: preview.reactions,
      firstAttachmentKind: preview.firstAttachmentKind,
      isDeleted: preview.isDeleted,
      mentions: preview.mentions,
    ),
    l10n: l10n,
  );
}

String formatMessagePreviewSummary(
  MessagePreview preview, {
  AppLocalizations? l10n,
}) {
  final stickerEmoji = preview.previewStickerEmoji;
  return formatMessagePreview(
    message: preview.message,
    messageType: preview.messageType,
    sticker:
        preview.sticker ??
        (stickerEmoji == null
            ? null
            : StickerSummary(id: 'message-preview', emoji: stickerEmoji)),
    attachments: preview.attachments,
    firstAttachmentKind: preview.firstAttachmentKind,
    isDeleted: preview.isDeleted,
    mentions: preview.mentions,
    l10n: l10n,
  );
}

String formatMessagePreview({
  String? message,
  String? messageType,
  StickerSummary? sticker,
  List<AttachmentItem> attachments = const <AttachmentItem>[],
  String? firstAttachmentKind,
  bool isDeleted = false,
  List<MentionInfo> mentions = const <MentionInfo>[],
  AppLocalizations? l10n,
}) {
  final labels = _PreviewLabels(l10n);
  if (isDeleted) {
    return labels.deleted;
  }

  if (messageType == 'invite') {
    return labels.invite;
  }

  if (messageType == 'sticker') {
    final emoji = sticker?.emoji?.trim();
    return emoji == null || emoji.isEmpty
        ? labels.sticker
        : '${labels.sticker} $emoji';
  }

  if (messageType == 'audio') {
    return labels.voiceMessage;
  }

  if (messageType == 'forwarded') {
    return labels.forwarded;
  }

  final text = message?.trim();
  if (text != null && text.isNotEmpty) {
    return renderMentionsAsText(text, mentions);
  }

  if (_containsAttachmentKind(attachments, 'audio/') ||
      (firstAttachmentKind?.startsWith('audio/') ?? false)) {
    return labels.voiceMessage;
  }

  if (_containsAttachmentKind(attachments, 'image/') ||
      (firstAttachmentKind?.startsWith('image/') ?? false)) {
    return labels.image;
  }

  if (_containsAttachmentKind(attachments, 'video/') ||
      (firstAttachmentKind?.startsWith('video/') ?? false)) {
    return labels.video;
  }

  if (attachments.isNotEmpty || firstAttachmentKind != null) {
    return labels.attachment;
  }

  return '';
}

class _PreviewLabels {
  const _PreviewLabels(this.l10n);

  final AppLocalizations? l10n;

  String get deleted => l10n?.previewDeleted ?? deletedPreviewLabel;
  String get invite => l10n?.previewInvite ?? invitePreviewLabel;
  String get sticker => l10n?.previewSticker ?? stickerPreviewLabel;
  String get voiceMessage =>
      l10n?.previewVoiceMessage ?? voiceMessagePreviewLabel;
  String get image => l10n?.previewImage ?? imagePreviewLabel;
  String get video => l10n?.previewVideo ?? videoPreviewLabel;
  String get attachment => l10n?.previewAttachment ?? attachmentPreviewLabel;
  String get forwarded => l10n?.previewForwarded ?? forwardedPreviewLabel;
}

bool _containsAttachmentKind(List<AttachmentItem> attachments, String prefix) {
  return attachments.any((attachment) => attachment.kind.startsWith(prefix));
}

String renderMentionsAsText(String text, List<MentionInfo> mentions) {
  if (mentions.isEmpty) {
    return text;
  }

  final mentionMap = <int, String>{};
  for (final mention in mentions) {
    final username = mention.username;
    if (username != null && username.isNotEmpty) {
      mentionMap[mention.uid] = username;
    }
  }

  return text.replaceAllMapped(RegExp(r'@\[uid:(\d+)\]'), (match) {
    final uid = int.tryParse(match.group(1) ?? '');
    if (uid == null) {
      return match.group(0) ?? '';
    }
    return '@${mentionMap[uid] ?? 'User $uid'}';
  });
}
