import 'package:json_annotation/json_annotation.dart';

import '../converters/flexible_int_converter.dart';
import '../converters/nullable_date_time_converter.dart';
import '../converters/string_value_converter.dart';

part 'messages_api_models.g.dart';

@JsonSerializable(explicitToJson: true)
class UserDto {
  const UserDto({
    required this.uid,
    this.name,
    this.avatarUrl,
    this.gender = 0,
    this.userGroup,
  });

  @FlexibleIntConverter()
  final int uid;
  final String? name;
  final String? avatarUrl;
  @JsonKey(defaultValue: 0)
  final int gender;
  final UserGroupTagInfoDto? userGroup;

  factory UserDto.fromJson(Map<String, dynamic> json) =>
      _$UserDtoFromJson(json);

  Map<String, dynamic> toJson() => _$UserDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class AttachmentItemDto {
  const AttachmentItemDto({
    required this.id,
    this.url = '',
    this.kind = 'application/octet-stream',
    this.size = 0,
    this.fileName = '',
    this.width,
    this.height,
  });

  @StringValueConverter()
  final String id;
  @JsonKey(defaultValue: '')
  final String url;
  @JsonKey(defaultValue: 'application/octet-stream')
  final String kind;
  @JsonKey(defaultValue: 0)
  final int size;
  @JsonKey(defaultValue: '')
  final String fileName;
  final int? width;
  final int? height;

  factory AttachmentItemDto.fromJson(Map<String, dynamic> json) =>
      _$AttachmentItemDtoFromJson(json);

  Map<String, dynamic> toJson() => _$AttachmentItemDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class StickerMediaDto {
  const StickerMediaDto({
    required this.id,
    this.url = '',
    this.contentType = 'image/webp',
    this.size = 0,
    this.width,
    this.height,
  });

  @StringValueConverter()
  final String id;
  @JsonKey(defaultValue: '')
  final String url;
  @JsonKey(defaultValue: 'image/webp')
  final String contentType;
  @JsonKey(defaultValue: 0)
  final int size;
  final int? width;
  final int? height;

  factory StickerMediaDto.fromJson(Map<String, dynamic> json) =>
      _$StickerMediaDtoFromJson(json);

  Map<String, dynamic> toJson() => _$StickerMediaDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class StickerSummaryDto {
  const StickerSummaryDto({
    this.id,
    this.media,
    this.emoji,
    this.name,
    this.description,
    this.createdAt,
    this.isFavorited,
  });

  final String? id;
  final StickerMediaDto? media;
  final String? emoji;
  final String? name;
  final String? description;
  @NullableDateTimeConverter()
  final DateTime? createdAt;
  final bool? isFavorited;

  factory StickerSummaryDto.fromJson(Map<String, dynamic> json) =>
      _$StickerSummaryDtoFromJson(json);

  Map<String, dynamic> toJson() => _$StickerSummaryDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MessagePreviewStickerDto {
  const MessagePreviewStickerDto({this.emoji});

  final String? emoji;

  factory MessagePreviewStickerDto.fromJson(Map<String, dynamic> json) =>
      _$MessagePreviewStickerDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MessagePreviewStickerDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class ReactionReactorDto {
  const ReactionReactorDto({required this.uid, this.name, this.avatarUrl});

  @FlexibleIntConverter()
  final int uid;
  final String? name;
  final String? avatarUrl;

  factory ReactionReactorDto.fromJson(Map<String, dynamic> json) =>
      _$ReactionReactorDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ReactionReactorDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class ReactionSummaryDto {
  const ReactionSummaryDto({
    required this.emoji,
    required this.count,
    this.reactedByMe,
    this.reactors,
  });

  final String emoji;
  @FlexibleIntConverter()
  final int count;
  final bool? reactedByMe;
  final List<ReactionReactorDto>? reactors;

  factory ReactionSummaryDto.fromJson(Map<String, dynamic> json) =>
      _$ReactionSummaryDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ReactionSummaryDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class UserGroupTagInfoDto {
  const UserGroupTagInfoDto({
    required this.groupId,
    this.name,
    this.chatGroupColor,
    this.chatGroupColorDark,
  });

  @FlexibleIntConverter()
  final int groupId;
  final String? name;
  final String? chatGroupColor;
  final String? chatGroupColorDark;

  factory UserGroupTagInfoDto.fromJson(Map<String, dynamic> json) =>
      _$UserGroupTagInfoDtoFromJson(json);

  Map<String, dynamic> toJson() => _$UserGroupTagInfoDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MentionInfoDto {
  const MentionInfoDto({
    required this.uid,
    this.username,
    this.avatarUrl,
    this.gender = 0,
    this.userGroup,
  });

  @FlexibleIntConverter()
  final int uid;
  final String? username;
  final String? avatarUrl;
  @JsonKey(defaultValue: 0)
  final int gender;
  final UserGroupTagInfoDto? userGroup;

  factory MentionInfoDto.fromJson(Map<String, dynamic> json) =>
      _$MentionInfoDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MentionInfoDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MessagePreviewDto {
  const MessagePreviewDto({
    required this.id,
    this.clientGeneratedId = '',
    required this.sender,
    this.message,
    this.messageType = 'text',
    this.sticker,
    this.createdAt,
    this.isDeleted = false,
    this.firstAttachmentKind,
    this.mentions = const <MentionInfoDto>[],
  });

  @FlexibleIntConverter()
  final int id;
  @JsonKey(defaultValue: '')
  final String clientGeneratedId;
  final UserDto sender;
  final String? message;
  @JsonKey(defaultValue: 'text')
  final String messageType;
  final MessagePreviewStickerDto? sticker;
  @NullableDateTimeConverter()
  final DateTime? createdAt;
  @JsonKey(defaultValue: false)
  final bool isDeleted;
  final String? firstAttachmentKind;
  @JsonKey(defaultValue: <MentionInfoDto>[])
  final List<MentionInfoDto> mentions;

  factory MessagePreviewDto.fromJson(Map<String, dynamic> json) =>
      _$MessagePreviewDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MessagePreviewDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class ThreadInfoDto {
  const ThreadInfoDto({this.replyCount = 0});

  @JsonKey(defaultValue: 0)
  final int replyCount;

  factory ThreadInfoDto.fromJson(Map<String, dynamic> json) =>
      _$ThreadInfoDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ThreadInfoDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MessageItemDto {
  const MessageItemDto({
    required this.id,
    this.message,
    this.messageType = 'text',
    this.sticker,
    required this.sender,
    required this.chatId,
    this.createdAt,
    this.isEdited = false,
    this.isDeleted = false,
    this.clientGeneratedId = '',
    this.replyRootId,
    this.hasAttachments = false,
    this.replyToMessage,
    this.attachments = const [],
    this.reactions = const [],
    this.mentions = const <MentionInfoDto>[],
    this.threadInfo,
  });

  @FlexibleIntConverter()
  final int id;
  final String? message;
  @JsonKey(defaultValue: 'text')
  final String messageType;
  final StickerSummaryDto? sticker;
  final UserDto sender;
  @FlexibleIntConverter()
  final int chatId;
  @NullableDateTimeConverter()
  final DateTime? createdAt;
  @JsonKey(defaultValue: false)
  final bool isEdited;
  @JsonKey(defaultValue: false)
  final bool isDeleted;
  @JsonKey(defaultValue: '')
  final String clientGeneratedId;
  @NullableFlexibleIntConverter()
  final int? replyRootId;
  @JsonKey(defaultValue: false)
  final bool hasAttachments;
  final MessagePreviewDto? replyToMessage;
  @JsonKey(defaultValue: <AttachmentItemDto>[])
  final List<AttachmentItemDto> attachments;
  @JsonKey(defaultValue: <ReactionSummaryDto>[])
  final List<ReactionSummaryDto> reactions;
  @JsonKey(defaultValue: <MentionInfoDto>[])
  final List<MentionInfoDto> mentions;
  final ThreadInfoDto? threadInfo;

  factory MessageItemDto.fromJson(Map<String, dynamic> json) =>
      _$MessageItemDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MessageItemDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class ListMessagesResponseDto {
  const ListMessagesResponseDto({
    this.messages = const [],
    this.nextCursor,
    this.prevCursor,
  });

  @JsonKey(defaultValue: <MessageItemDto>[])
  final List<MessageItemDto> messages;
  final String? nextCursor;
  final String? prevCursor;

  factory ListMessagesResponseDto.fromJson(Map<String, dynamic> json) =>
      _$ListMessagesResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$ListMessagesResponseDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class SearchMessagesResponseDto {
  const SearchMessagesResponseDto({this.messages = const [], this.nextOffset});

  @JsonKey(defaultValue: <MessageItemDto>[])
  final List<MessageItemDto> messages;
  final int? nextOffset;

  factory SearchMessagesResponseDto.fromJson(Map<String, dynamic> json) =>
      _$SearchMessagesResponseDtoFromJson(json);

  Map<String, dynamic> toJson() => _$SearchMessagesResponseDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class SendMessageRequestDto {
  const SendMessageRequestDto({
    required this.message,
    required this.messageType,
    required this.clientGeneratedId,
    this.attachmentIds = const <String>[],
    this.replyToId,
    this.stickerId,
  });

  final String message;
  final String messageType;
  final String clientGeneratedId;
  final List<String> attachmentIds;
  final int? replyToId;
  @JsonKey(includeIfNull: false)
  final String? stickerId;

  factory SendMessageRequestDto.fromJson(Map<String, dynamic> json) =>
      _$SendMessageRequestDtoFromJson(json);

  Map<String, dynamic> toJson() => _$SendMessageRequestDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class EditMessageRequestDto {
  const EditMessageRequestDto({
    required this.message,
    this.attachmentIds = const <String>[],
  });

  final String message;
  final List<String> attachmentIds;

  factory EditMessageRequestDto.fromJson(Map<String, dynamic> json) =>
      _$EditMessageRequestDtoFromJson(json);

  Map<String, dynamic> toJson() => _$EditMessageRequestDtoToJson(this);
}

@JsonSerializable(explicitToJson: true)
class MarkReadRequestDto {
  const MarkReadRequestDto({required this.messageId});

  @FlexibleIntConverter()
  final int messageId;

  factory MarkReadRequestDto.fromJson(Map<String, dynamic> json) =>
      _$MarkReadRequestDtoFromJson(json);

  Map<String, dynamic> toJson() => _$MarkReadRequestDtoToJson(this);
}
