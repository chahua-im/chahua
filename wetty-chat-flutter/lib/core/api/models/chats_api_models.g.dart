// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'chats_api_models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ChatListItemDto _$ChatListItemDtoFromJson(
  Map<String, dynamic> json,
) => ChatListItemDto(
  id: const FlexibleIntConverter().fromJson(json['id']),
  name: json['name'] as String?,
  avatar: json['avatar'] as String?,
  lastMessageAt: const NullableDateTimeConverter().fromJson(
    json['lastMessageAt'],
  ),
  unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
  lastReadMessageId: json['lastReadMessageId'] as String?,
  lastMessage: json['lastMessage'] == null
      ? null
      : MessagePreviewDto.fromJson(json['lastMessage'] as Map<String, dynamic>),
  mutedUntil: const NullableDateTimeConverter().fromJson(json['mutedUntil']),
  archived: json['archived'] as bool? ?? false,
);

Map<String, dynamic> _$ChatListItemDtoToJson(
  ChatListItemDto instance,
) => <String, dynamic>{
  'id': const FlexibleIntConverter().toJson(instance.id),
  'name': instance.name,
  'avatar': instance.avatar,
  'lastMessageAt': const NullableDateTimeConverter().toJson(
    instance.lastMessageAt,
  ),
  'unreadCount': instance.unreadCount,
  'lastReadMessageId': instance.lastReadMessageId,
  'lastMessage': instance.lastMessage?.toJson(),
  'mutedUntil': const NullableDateTimeConverter().toJson(instance.mutedUntil),
  'archived': instance.archived,
};

ListChatsResponseDto _$ListChatsResponseDtoFromJson(
  Map<String, dynamic> json,
) => ListChatsResponseDto(
  chats:
      (json['chats'] as List<dynamic>?)
          ?.map((e) => ChatListItemDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  nextCursor: json['nextCursor'] as String?,
);

Map<String, dynamic> _$ListChatsResponseDtoToJson(
  ListChatsResponseDto instance,
) => <String, dynamic>{
  'chats': instance.chats.map((e) => e.toJson()).toList(),
  'nextCursor': instance.nextCursor,
};

CreateChatRequestDto _$CreateChatRequestDtoFromJson(
  Map<String, dynamic> json,
) => CreateChatRequestDto(name: json['name'] as String?);

Map<String, dynamic> _$CreateChatRequestDtoToJson(
  CreateChatRequestDto instance,
) => <String, dynamic>{'name': instance.name};

CreateChatResponseDto _$CreateChatResponseDtoFromJson(
  Map<String, dynamic> json,
) => CreateChatResponseDto(
  id: const FlexibleIntConverter().fromJson(json['id']),
  name: json['name'] as String?,
);

Map<String, dynamic> _$CreateChatResponseDtoToJson(
  CreateChatResponseDto instance,
) => <String, dynamic>{
  'id': const FlexibleIntConverter().toJson(instance.id),
  'name': instance.name,
};

UnreadCountResponseDto _$UnreadCountResponseDtoFromJson(
  Map<String, dynamic> json,
) => UnreadCountResponseDto(
  unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
  archivedUnreadCount: (json['archivedUnreadCount'] as num?)?.toInt() ?? 0,
  unreadChatCount: (json['unreadChatCount'] as num?)?.toInt() ?? 0,
  archivedUnreadChatCount:
      (json['archivedUnreadChatCount'] as num?)?.toInt() ?? 0,
);

Map<String, dynamic> _$UnreadCountResponseDtoToJson(
  UnreadCountResponseDto instance,
) => <String, dynamic>{
  'unreadCount': instance.unreadCount,
  'archivedUnreadCount': instance.archivedUnreadCount,
  'unreadChatCount': instance.unreadChatCount,
  'archivedUnreadChatCount': instance.archivedUnreadChatCount,
};

MarkChatReadStateResponseDto _$MarkChatReadStateResponseDtoFromJson(
  Map<String, dynamic> json,
) => MarkChatReadStateResponseDto(
  lastReadMessageId: json['lastReadMessageId'] as String?,
  unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
);

Map<String, dynamic> _$MarkChatReadStateResponseDtoToJson(
  MarkChatReadStateResponseDto instance,
) => <String, dynamic>{
  'lastReadMessageId': instance.lastReadMessageId,
  'unreadCount': instance.unreadCount,
};
