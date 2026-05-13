import 'package:freezed_annotation/freezed_annotation.dart';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/features/shared/model/message/message_preview.dart';

part 'chat_list_item.freezed.dart';

@freezed
abstract class ChatListItem with _$ChatListItem {
  const factory ChatListItem({
    required String id,
    String? name,
    String? avatarUrl,
    DateTime? lastMessageAt,
    @Default(0) int unreadCount,
    String? lastReadMessageId,
    MessagePreview? lastMessage,
    DateTime? mutedUntil,
    @Default(false) bool archived,
  }) = _ChatListItem;

  factory ChatListItem.fromDto(ChatListItemDto dto) => ChatListItem(
    id: dto.id.toString(),
    name: dto.name,
    avatarUrl: dto.avatar,
    lastMessageAt: dto.lastMessageAt,
    unreadCount: dto.unreadCount,
    lastReadMessageId: dto.lastReadMessageId,
    lastMessage: dto.lastMessage == null
        ? null
        : MessagePreview.fromDto(dto.lastMessage!),
    mutedUntil: dto.mutedUntil,
    archived: dto.archived,
  );
}
