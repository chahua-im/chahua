import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/shared/model/message/message.dart';

bool isEligibleChatPreviewPayload(MessageItemDto payload) {
  return payload.replyRootId == null && !payload.isDeleted;
}

bool isEligibleThreadPreviewPayload(MessageItemDto payload) {
  return payload.replyRootId != null && !payload.isDeleted;
}

bool matchesChatPreview(MessagePreview? preview, MessageItemDto payload) {
  if (preview == null) {
    return false;
  }
  if (preview.messageId == payload.id) {
    return true;
  }
  final clientGeneratedId = preview.clientGeneratedId;
  return clientGeneratedId != null &&
      clientGeneratedId.isNotEmpty &&
      clientGeneratedId == payload.clientGeneratedId;
}

bool matchesThreadPreview(MessagePreview? preview, MessageItemDto payload) {
  if (preview == null) {
    return false;
  }
  if (preview.messageId == payload.id) return true;
  final clientGeneratedId = preview.clientGeneratedId;
  return clientGeneratedId != null &&
      clientGeneratedId.isNotEmpty &&
      clientGeneratedId == payload.clientGeneratedId;
}

MessagePreview messagePreviewFromMessageItemDto(MessageItemDto payload) {
  return MessagePreview(
    messageId: payload.id,
    clientGeneratedId: payload.clientGeneratedId.isEmpty
        ? null
        : payload.clientGeneratedId,
    sender: User.fromDto(payload.sender),
    message: payload.message,
    messageType: payload.messageType,
    sticker: payload.sticker == null
        ? null
        : StickerSummary.fromDto(payload.sticker!),
    createdAt: payload.createdAt,
    attachmentKinds: payload.attachments
        .map((attachment) => attachment.kind)
        .toList(growable: false),
    isDeleted: payload.isDeleted,
    mentions: payload.mentions.map(MentionInfo.fromDto).toList(),
  );
}
