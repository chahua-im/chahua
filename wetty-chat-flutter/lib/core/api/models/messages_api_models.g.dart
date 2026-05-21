// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'messages_api_models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

UserDto _$UserDtoFromJson(Map<String, dynamic> json) => UserDto(
  uid: const FlexibleIntConverter().fromJson(json['uid']),
  name: json['name'] as String?,
  avatarUrl: json['avatarUrl'] as String?,
  gender: (json['gender'] as num?)?.toInt() ?? 0,
  userGroup: json['userGroup'] == null
      ? null
      : UserGroupTagInfoDto.fromJson(json['userGroup'] as Map<String, dynamic>),
);

Map<String, dynamic> _$UserDtoToJson(UserDto instance) => <String, dynamic>{
  'uid': const FlexibleIntConverter().toJson(instance.uid),
  'name': instance.name,
  'avatarUrl': instance.avatarUrl,
  'gender': instance.gender,
  'userGroup': instance.userGroup?.toJson(),
};

AttachmentItemDto _$AttachmentItemDtoFromJson(Map<String, dynamic> json) =>
    AttachmentItemDto(
      id: const StringValueConverter().fromJson(json['id']),
      url: json['url'] as String? ?? '',
      kind: json['kind'] as String? ?? 'application/octet-stream',
      size: (json['size'] as num?)?.toInt() ?? 0,
      fileName: json['fileName'] as String? ?? '',
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
    );

Map<String, dynamic> _$AttachmentItemDtoToJson(AttachmentItemDto instance) =>
    <String, dynamic>{
      'id': const StringValueConverter().toJson(instance.id),
      'url': instance.url,
      'kind': instance.kind,
      'size': instance.size,
      'fileName': instance.fileName,
      'width': instance.width,
      'height': instance.height,
    };

StickerMediaDto _$StickerMediaDtoFromJson(Map<String, dynamic> json) =>
    StickerMediaDto(
      id: const StringValueConverter().fromJson(json['id']),
      url: json['url'] as String? ?? '',
      contentType: json['contentType'] as String? ?? 'image/webp',
      size: (json['size'] as num?)?.toInt() ?? 0,
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
    );

Map<String, dynamic> _$StickerMediaDtoToJson(StickerMediaDto instance) =>
    <String, dynamic>{
      'id': const StringValueConverter().toJson(instance.id),
      'url': instance.url,
      'contentType': instance.contentType,
      'size': instance.size,
      'width': instance.width,
      'height': instance.height,
    };

StickerSummaryDto _$StickerSummaryDtoFromJson(Map<String, dynamic> json) =>
    StickerSummaryDto(
      id: json['id'] as String?,
      media: json['media'] == null
          ? null
          : StickerMediaDto.fromJson(json['media'] as Map<String, dynamic>),
      emoji: json['emoji'] as String?,
      name: json['name'] as String?,
      description: json['description'] as String?,
      createdAt: const NullableDateTimeConverter().fromJson(json['createdAt']),
      isFavorited: json['isFavorited'] as bool?,
    );

Map<String, dynamic> _$StickerSummaryDtoToJson(StickerSummaryDto instance) =>
    <String, dynamic>{
      'id': instance.id,
      'media': instance.media?.toJson(),
      'emoji': instance.emoji,
      'name': instance.name,
      'description': instance.description,
      'createdAt': const NullableDateTimeConverter().toJson(instance.createdAt),
      'isFavorited': instance.isFavorited,
    };

MessagePreviewStickerDto _$MessagePreviewStickerDtoFromJson(
  Map<String, dynamic> json,
) => MessagePreviewStickerDto(emoji: json['emoji'] as String?);

Map<String, dynamic> _$MessagePreviewStickerDtoToJson(
  MessagePreviewStickerDto instance,
) => <String, dynamic>{'emoji': instance.emoji};

ReactionReactorDto _$ReactionReactorDtoFromJson(Map<String, dynamic> json) =>
    ReactionReactorDto(
      uid: const FlexibleIntConverter().fromJson(json['uid']),
      name: json['name'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
    );

Map<String, dynamic> _$ReactionReactorDtoToJson(ReactionReactorDto instance) =>
    <String, dynamic>{
      'uid': const FlexibleIntConverter().toJson(instance.uid),
      'name': instance.name,
      'avatarUrl': instance.avatarUrl,
    };

ReactionSummaryDto _$ReactionSummaryDtoFromJson(Map<String, dynamic> json) =>
    ReactionSummaryDto(
      emoji: json['emoji'] as String,
      count: const FlexibleIntConverter().fromJson(json['count']),
      reactedByMe: json['reactedByMe'] as bool?,
      reactors: (json['reactors'] as List<dynamic>?)
          ?.map((e) => ReactionReactorDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$ReactionSummaryDtoToJson(ReactionSummaryDto instance) =>
    <String, dynamic>{
      'emoji': instance.emoji,
      'count': const FlexibleIntConverter().toJson(instance.count),
      'reactedByMe': instance.reactedByMe,
      'reactors': instance.reactors?.map((e) => e.toJson()).toList(),
    };

UserGroupTagInfoDto _$UserGroupTagInfoDtoFromJson(Map<String, dynamic> json) =>
    UserGroupTagInfoDto(
      groupId: const FlexibleIntConverter().fromJson(json['groupId']),
      name: json['name'] as String?,
      chatGroupColor: json['chatGroupColor'] as String?,
      chatGroupColorDark: json['chatGroupColorDark'] as String?,
    );

Map<String, dynamic> _$UserGroupTagInfoDtoToJson(
  UserGroupTagInfoDto instance,
) => <String, dynamic>{
  'groupId': const FlexibleIntConverter().toJson(instance.groupId),
  'name': instance.name,
  'chatGroupColor': instance.chatGroupColor,
  'chatGroupColorDark': instance.chatGroupColorDark,
};

MentionInfoDto _$MentionInfoDtoFromJson(Map<String, dynamic> json) =>
    MentionInfoDto(
      uid: const FlexibleIntConverter().fromJson(json['uid']),
      username: json['username'] as String?,
      avatarUrl: json['avatarUrl'] as String?,
      gender: (json['gender'] as num?)?.toInt() ?? 0,
      userGroup: json['userGroup'] == null
          ? null
          : UserGroupTagInfoDto.fromJson(
              json['userGroup'] as Map<String, dynamic>,
            ),
    );

Map<String, dynamic> _$MentionInfoDtoToJson(MentionInfoDto instance) =>
    <String, dynamic>{
      'uid': const FlexibleIntConverter().toJson(instance.uid),
      'username': instance.username,
      'avatarUrl': instance.avatarUrl,
      'gender': instance.gender,
      'userGroup': instance.userGroup?.toJson(),
    };

MessagePreviewDto _$MessagePreviewDtoFromJson(Map<String, dynamic> json) =>
    MessagePreviewDto(
      id: const FlexibleIntConverter().fromJson(json['id']),
      clientGeneratedId: json['clientGeneratedId'] as String? ?? '',
      sender: UserDto.fromJson(json['sender'] as Map<String, dynamic>),
      message: json['message'] as String?,
      messageType: json['messageType'] as String? ?? 'text',
      sticker: json['sticker'] == null
          ? null
          : MessagePreviewStickerDto.fromJson(
              json['sticker'] as Map<String, dynamic>,
            ),
      createdAt: const NullableDateTimeConverter().fromJson(json['createdAt']),
      isDeleted: json['isDeleted'] as bool? ?? false,
      firstAttachmentKind: json['firstAttachmentKind'] as String?,
      mentions:
          (json['mentions'] as List<dynamic>?)
              ?.map((e) => MentionInfoDto.fromJson(e as Map<String, dynamic>))
              .toList() ??
          [],
    );

Map<String, dynamic> _$MessagePreviewDtoToJson(MessagePreviewDto instance) =>
    <String, dynamic>{
      'id': const FlexibleIntConverter().toJson(instance.id),
      'clientGeneratedId': instance.clientGeneratedId,
      'sender': instance.sender.toJson(),
      'message': instance.message,
      'messageType': instance.messageType,
      'sticker': instance.sticker?.toJson(),
      'createdAt': const NullableDateTimeConverter().toJson(instance.createdAt),
      'isDeleted': instance.isDeleted,
      'firstAttachmentKind': instance.firstAttachmentKind,
      'mentions': instance.mentions.map((e) => e.toJson()).toList(),
    };

ThreadInfoDto _$ThreadInfoDtoFromJson(Map<String, dynamic> json) =>
    ThreadInfoDto(replyCount: (json['replyCount'] as num?)?.toInt() ?? 0);

Map<String, dynamic> _$ThreadInfoDtoToJson(ThreadInfoDto instance) =>
    <String, dynamic>{'replyCount': instance.replyCount};

MessageItemDto _$MessageItemDtoFromJson(
  Map<String, dynamic> json,
) => MessageItemDto(
  id: const FlexibleIntConverter().fromJson(json['id']),
  message: json['message'] as String?,
  messageType: json['messageType'] as String? ?? 'text',
  sticker: json['sticker'] == null
      ? null
      : StickerSummaryDto.fromJson(json['sticker'] as Map<String, dynamic>),
  sender: UserDto.fromJson(json['sender'] as Map<String, dynamic>),
  chatId: const FlexibleIntConverter().fromJson(json['chatId']),
  createdAt: const NullableDateTimeConverter().fromJson(json['createdAt']),
  isEdited: json['isEdited'] as bool? ?? false,
  isDeleted: json['isDeleted'] as bool? ?? false,
  clientGeneratedId: json['clientGeneratedId'] as String? ?? '',
  replyRootId: const NullableFlexibleIntConverter().fromJson(
    json['replyRootId'],
  ),
  hasAttachments: json['hasAttachments'] as bool? ?? false,
  replyToMessage: json['replyToMessage'] == null
      ? null
      : MessagePreviewDto.fromJson(
          json['replyToMessage'] as Map<String, dynamic>,
        ),
  attachments:
      (json['attachments'] as List<dynamic>?)
          ?.map((e) => AttachmentItemDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  reactions:
      (json['reactions'] as List<dynamic>?)
          ?.map((e) => ReactionSummaryDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  mentions:
      (json['mentions'] as List<dynamic>?)
          ?.map((e) => MentionInfoDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  threadInfo: json['threadInfo'] == null
      ? null
      : ThreadInfoDto.fromJson(json['threadInfo'] as Map<String, dynamic>),
);

Map<String, dynamic> _$MessageItemDtoToJson(MessageItemDto instance) =>
    <String, dynamic>{
      'id': const FlexibleIntConverter().toJson(instance.id),
      'message': instance.message,
      'messageType': instance.messageType,
      'sticker': instance.sticker?.toJson(),
      'sender': instance.sender.toJson(),
      'chatId': const FlexibleIntConverter().toJson(instance.chatId),
      'createdAt': const NullableDateTimeConverter().toJson(instance.createdAt),
      'isEdited': instance.isEdited,
      'isDeleted': instance.isDeleted,
      'clientGeneratedId': instance.clientGeneratedId,
      'replyRootId': const NullableFlexibleIntConverter().toJson(
        instance.replyRootId,
      ),
      'hasAttachments': instance.hasAttachments,
      'replyToMessage': instance.replyToMessage?.toJson(),
      'attachments': instance.attachments.map((e) => e.toJson()).toList(),
      'reactions': instance.reactions.map((e) => e.toJson()).toList(),
      'mentions': instance.mentions.map((e) => e.toJson()).toList(),
      'threadInfo': instance.threadInfo?.toJson(),
    };

ListMessagesResponseDto _$ListMessagesResponseDtoFromJson(
  Map<String, dynamic> json,
) => ListMessagesResponseDto(
  messages:
      (json['messages'] as List<dynamic>?)
          ?.map((e) => MessageItemDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  nextCursor: json['nextCursor'] as String?,
  prevCursor: json['prevCursor'] as String?,
);

Map<String, dynamic> _$ListMessagesResponseDtoToJson(
  ListMessagesResponseDto instance,
) => <String, dynamic>{
  'messages': instance.messages.map((e) => e.toJson()).toList(),
  'nextCursor': instance.nextCursor,
  'prevCursor': instance.prevCursor,
};

SearchMessagesResponseDto _$SearchMessagesResponseDtoFromJson(
  Map<String, dynamic> json,
) => SearchMessagesResponseDto(
  messages:
      (json['messages'] as List<dynamic>?)
          ?.map((e) => MessageItemDto.fromJson(e as Map<String, dynamic>))
          .toList() ??
      [],
  nextOffset: (json['nextOffset'] as num?)?.toInt(),
);

Map<String, dynamic> _$SearchMessagesResponseDtoToJson(
  SearchMessagesResponseDto instance,
) => <String, dynamic>{
  'messages': instance.messages.map((e) => e.toJson()).toList(),
  'nextOffset': instance.nextOffset,
};

SendMessageRequestDto _$SendMessageRequestDtoFromJson(
  Map<String, dynamic> json,
) => SendMessageRequestDto(
  message: json['message'] as String,
  messageType: json['messageType'] as String,
  clientGeneratedId: json['clientGeneratedId'] as String,
  attachmentIds:
      (json['attachmentIds'] as List<dynamic>?)
          ?.map((e) => e as String)
          .toList() ??
      const <String>[],
  replyToId: (json['replyToId'] as num?)?.toInt(),
  stickerId: json['stickerId'] as String?,
);

Map<String, dynamic> _$SendMessageRequestDtoToJson(
  SendMessageRequestDto instance,
) => <String, dynamic>{
  'message': instance.message,
  'messageType': instance.messageType,
  'clientGeneratedId': instance.clientGeneratedId,
  'attachmentIds': instance.attachmentIds,
  'replyToId': instance.replyToId,
  'stickerId': ?instance.stickerId,
};

EditMessageRequestDto _$EditMessageRequestDtoFromJson(
  Map<String, dynamic> json,
) => EditMessageRequestDto(
  message: json['message'] as String,
  attachmentIds:
      (json['attachmentIds'] as List<dynamic>?)
          ?.map((e) => e as String)
          .toList() ??
      const <String>[],
);

Map<String, dynamic> _$EditMessageRequestDtoToJson(
  EditMessageRequestDto instance,
) => <String, dynamic>{
  'message': instance.message,
  'attachmentIds': instance.attachmentIds,
};

MarkReadRequestDto _$MarkReadRequestDtoFromJson(Map<String, dynamic> json) =>
    MarkReadRequestDto(
      messageId: const FlexibleIntConverter().fromJson(json['messageId']),
    );

Map<String, dynamic> _$MarkReadRequestDtoToJson(MarkReadRequestDto instance) =>
    <String, dynamic>{
      'messageId': const FlexibleIntConverter().toJson(instance.messageId),
    };
