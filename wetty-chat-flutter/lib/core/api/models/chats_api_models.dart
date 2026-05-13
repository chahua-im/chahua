import 'package:json_annotation/json_annotation.dart';

import '../converters/flexible_int_converter.dart';
import '../converters/nullable_date_time_converter.dart';
import 'messages_api_models.dart';

part 'chats_api_models.g.dart';

@JsonSerializable(explicitToJson: true)
class ChatListItemDto {
  const ChatListItemDto({
    required this.id,
    this.name,
    this.avatar,
    this.lastMessageAt,
    this.unreadCount = 0,
    this.lastReadMessageId,
    this.lastMessage,
    this.mutedUntil,
    this.archived = false,
  });

  @FlexibleIntConverter()
  final int id;
  final String? name;
  final String? avatar;
  @NullableDateTimeConverter()
  final DateTime? lastMessageAt;
  @JsonKey(defaultValue: 0)
  final int unreadCount;
  final String? lastReadMessageId;
  final MessagePreviewDto? lastMessage;
  @NullableDateTimeConverter()
  final DateTime? mutedUntil;
  @JsonKey(defaultValue: false)
  final bool archived;

  factory ChatListItemDto.fromJson(Map<String, dynamic> json) =>
      _$ChatListItemDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ChatListItemDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class ListChatsResponseDto {
  const ListChatsResponseDto({this.chats = const [], this.nextCursor});

  @JsonKey(defaultValue: <ChatListItemDto>[])
  final List<ChatListItemDto> chats;
  final String? nextCursor;

  factory ListChatsResponseDto.fromJson(Map<String, dynamic> json) =>
      _$ListChatsResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ListChatsResponseDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class CreateChatRequestDto {
  const CreateChatRequestDto({this.name});

  final String? name;

  factory CreateChatRequestDto.fromJson(Map<String, dynamic> json) =>
      _$CreateChatRequestDtoFromJson(json);

  Map<String, dynamic> toJson() => _$CreateChatRequestDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class CreateChatResponseDto {
  const CreateChatResponseDto({required this.id, this.name});

  @FlexibleIntConverter()
  final int id;
  final String? name;

  factory CreateChatResponseDto.fromJson(Map<String, dynamic> json) =>
      _$CreateChatResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$CreateChatResponseDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class UnreadCountResponseDto {
  const UnreadCountResponseDto({
    this.unreadCount = 0,
    this.archivedUnreadCount = 0,
    this.unreadChatCount = 0,
    this.archivedUnreadChatCount = 0,
  });

  @JsonKey(defaultValue: 0)
  final int unreadCount;
  @JsonKey(defaultValue: 0)
  final int archivedUnreadCount;
  @JsonKey(defaultValue: 0)
  final int unreadChatCount;
  @JsonKey(defaultValue: 0)
  final int archivedUnreadChatCount;

  factory UnreadCountResponseDto.fromJson(Map<String, dynamic> json) =>
      _$UnreadCountResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$UnreadCountResponseDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MarkChatReadStateResponseDto {
  const MarkChatReadStateResponseDto({
    this.lastReadMessageId,
    this.unreadCount = 0,
  });

  final String? lastReadMessageId;
  @JsonKey(defaultValue: 0)
  final int unreadCount;

  factory MarkChatReadStateResponseDto.fromJson(Map<String, dynamic> json) =>
      _$MarkChatReadStateResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MarkChatReadStateResponseDtoToJson(this);
}
