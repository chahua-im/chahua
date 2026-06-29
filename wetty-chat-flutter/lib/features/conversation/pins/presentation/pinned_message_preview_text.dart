import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';

String pinnedMessageSenderName(User sender, AppLocalizations l10n) {
  final name = sender.name?.trim();
  if (name != null && name.isNotEmpty) {
    return name;
  }
  return l10n.userFallbackName(sender.uid);
}

String formatPinnedMessagePreview(
  ConversationMessageV2 message,
  AppLocalizations l10n,
) {
  if (message.isDeleted) {
    return l10n.previewDeleted;
  }
  return switch (message.content) {
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
    SystemMessageContent(:final text) => formatMessagePreview(
      message: text,
      messageType: 'system',
      l10n: l10n,
    ),
    ForwardedMessageContent() => formatMessagePreview(
      messageType: 'forwarded',
      l10n: l10n,
    ),
  };
}
