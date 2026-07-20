import 'package:freezed_annotation/freezed_annotation.dart';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'mention.dart';
import 'reaction.dart';
import 'user.dart';
import 'sticker.dart';

part 'message_preview.freezed.dart';

@freezed
abstract class MessagePreview with _$MessagePreview {
  const MessagePreview._();

  const factory MessagePreview({
    required int messageId,
    String? clientGeneratedId,
    required User sender,
    String? message,
    @Default('text') String messageType,
    StickerSummary? sticker,
    DateTime? createdAt,
    @Default([]) List<String> attachmentKinds,
    @Default([]) List<ReactionSummary> reactions,
    @Default(false) bool isDeleted,
    @Default([]) List<MentionInfo> mentions,
  }) = _MessagePreview;

  String? get previewStickerEmoji => sticker?.emoji;

  factory MessagePreview.fromDto(MessagePreviewDto dto) => MessagePreview(
    messageId: dto.id,
    clientGeneratedId: dto.clientGeneratedId.isEmpty
        ? null
        : dto.clientGeneratedId,
    sender: User.fromDto(dto.sender),
    message: dto.message,
    messageType: dto.messageType,
    sticker: dto.sticker?.emoji == null
        ? null
        : StickerSummary(
            id: 'message-preview-${dto.id}',
            emoji: dto.sticker!.emoji,
          ),
    createdAt: dto.createdAt,
    attachmentKinds: dto.attachments
        .map((attachment) => attachment.kind)
        .toList(growable: false),
    isDeleted: dto.isDeleted,
    mentions: dto.mentions.map(MentionInfo.fromDto).toList(),
  );
}
