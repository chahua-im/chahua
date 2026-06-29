import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:flutter/rendering.dart';

import 'attachment.dart';
import 'mention.dart';
import 'reaction.dart';
import 'reply_to_message.dart';
import 'user.dart';
import 'sticker.dart';
import 'thread_info.dart';

export 'attachment.dart';
export 'mention.dart';
export 'message_item.dart';
export 'message_preview.dart';
export 'preview_formatter.dart';
export 'reaction.dart';
export 'reply_to_message.dart';
export 'user.dart';
export 'sticker.dart';
export 'thread_info.dart';

enum ConversationDeliveryState {
  sending,
  sent,
  confirmed,
  failed,
  editing,
  deleting,
}

class ConversationMessageV2 {
  const ConversationMessageV2({
    required this.clientGeneratedId,
    required this.sender,
    required this.content,
    this.serverMessageId,
    this.createdAt,
    this.isEdited = false,
    this.isDeleted = false,
    this.replyToMessage,
    this.reactions = const <ReactionSummary>[],
    this.threadInfo,
    this.deliveryState = ConversationDeliveryState.confirmed,
    this.localSendOrder,
  });

  factory ConversationMessageV2.fromMessageItemDto(MessageItemDto dto) {
    final attachments = dto.attachments
        .map(AttachmentItem.fromDto)
        .toList(growable: false);
    final mentions = dto.mentions
        .map(MentionInfo.fromDto)
        .toList(growable: false);
    final sticker = dto.sticker == null
        ? null
        : StickerSummary.fromDto(dto.sticker!);
    final forwardedMessages = dto.forwardedMessages
        ?.map(ForwardedMessageSnapshot.fromDto)
        .toList(growable: false);

    return ConversationMessageV2(
      serverMessageId: dto.id,
      clientGeneratedId: dto.clientGeneratedId,
      sender: User.fromDto(dto.sender),
      createdAt: dto.createdAt,
      isEdited: dto.isEdited,
      isDeleted: dto.isDeleted,
      replyToMessage: dto.replyToMessage == null
          ? null
          : ReplyToMessage.fromDto(dto.replyToMessage!),
      reactions: dto.reactions
          .map(ReactionSummary.fromDto)
          .toList(growable: false),
      threadInfo: dto.threadInfo == null
          ? null
          : ThreadInfo.fromDto(dto.threadInfo!),
      deliveryState: ConversationDeliveryState.confirmed,
      content: _contentFromMessageItemDto(
        messageType: dto.messageType,
        message: dto.message,
        sticker: sticker,
        attachments: attachments,
        mentions: mentions,
        forwardedMessages: forwardedMessages,
      ),
    );
  }

  final int? serverMessageId;
  final String clientGeneratedId;
  final User sender;
  final DateTime? createdAt;
  final bool isEdited;
  final bool isDeleted;
  final ReplyToMessage? replyToMessage;
  final List<ReactionSummary> reactions;
  final ThreadInfo? threadInfo;
  final ConversationDeliveryState deliveryState;
  final MessageContent content;
  final int? localSendOrder;

  ConversationMessageV2 copyWith({
    int? serverMessageId,
    String? clientGeneratedId,
    User? sender,
    DateTime? createdAt,
    bool? isEdited,
    bool? isDeleted,
    ReplyToMessage? replyToMessage,
    List<ReactionSummary>? reactions,
    ThreadInfo? threadInfo,
    ConversationDeliveryState? deliveryState,
    MessageContent? content,
    int? localSendOrder,
  }) {
    return ConversationMessageV2(
      serverMessageId: serverMessageId ?? this.serverMessageId,
      clientGeneratedId: clientGeneratedId ?? this.clientGeneratedId,
      sender: sender ?? this.sender,
      createdAt: createdAt ?? this.createdAt,
      isEdited: isEdited ?? this.isEdited,
      isDeleted: isDeleted ?? this.isDeleted,
      replyToMessage: replyToMessage ?? this.replyToMessage,
      reactions: reactions ?? this.reactions,
      threadInfo: threadInfo ?? this.threadInfo,
      deliveryState: deliveryState ?? this.deliveryState,
      content: content ?? this.content,
      localSendOrder: localSendOrder ?? this.localSendOrder,
    );
  }

  String get stableKey {
    if (clientGeneratedId.isNotEmpty) {
      return 'client:$clientGeneratedId';
    }
    if (serverMessageId != null) {
      return 'server:$serverMessageId';
    }
    throw StateError('ConversationMessageV2 has no stable identity');
  }
}

MessageContent _contentFromMessageItemDto({
  required String messageType,
  required String? message,
  required StickerSummary? sticker,
  required List<AttachmentItem> attachments,
  required List<MentionInfo> mentions,
  required List<ForwardedMessageSnapshot>? forwardedMessages,
}) {
  if (messageType == 'system') {
    return SystemMessageContent(text: message ?? '');
  }
  if (messageType == 'sticker') {
    if (sticker?.id == null) {
      throw StateError('Sticker messages must include a sticker id');
    }
    return StickerMessageContent(sticker: sticker!);
  }
  if (messageType == 'invite') {
    return InviteMessageContent(text: message, mentions: mentions);
  }
  if (messageType == 'forwarded') {
    return ForwardedMessageContent(messages: forwardedMessages ?? const []);
  }
  if (messageType == 'audio') {
    if (attachments.isEmpty) {
      throw StateError('Audio messages must include an audio attachment');
    }
    return AudioMessageContent(
      audio: attachments.first,
      text: message,
      mentions: mentions,
    );
  }
  return TextMessageContent(
    text: message ?? '',
    attachments: attachments,
    mentions: mentions,
  );
}

sealed class MessageContent {
  const MessageContent();
}

class TextMessageContent extends MessageContent {
  const TextMessageContent({
    required this.text,
    this.attachments = const <AttachmentItem>[],
    this.mentions = const <MentionInfo>[],
  });

  final String text;
  final List<AttachmentItem> attachments;
  final List<MentionInfo> mentions;
}

class AudioMessageContent extends MessageContent {
  const AudioMessageContent({
    required this.audio,
    this.text,
    this.mentions = const <MentionInfo>[],
  });

  final AttachmentItem audio;
  final String? text;
  final List<MentionInfo> mentions;
}

class StickerMessageContent extends MessageContent {
  const StickerMessageContent({required this.sticker});

  final StickerSummary sticker;
}

class InviteMessageContent extends MessageContent {
  const InviteMessageContent({
    this.text,
    this.mentions = const <MentionInfo>[],
  });

  final String? text;
  final List<MentionInfo> mentions;
}

class ForwardedMessageContent extends MessageContent {
  const ForwardedMessageContent({required this.messages});

  final List<ForwardedMessageSnapshot> messages;
}

class ForwardedMessageSnapshot {
  const ForwardedMessageSnapshot({
    required this.originalMessageId,
    required this.originalChatId,
    required this.sender,
    required this.content,
    this.originalCreatedAt,
    this.replyToMessage,
  });

  factory ForwardedMessageSnapshot.fromDto(ForwardedMessageSnapshotDto dto) {
    final attachments = dto.attachments
        .map(AttachmentItem.fromDto)
        .toList(growable: false);
    final mentions = dto.mentions
        .map(MentionInfo.fromDto)
        .toList(growable: false);

    return ForwardedMessageSnapshot(
      originalMessageId: dto.originalMessageId,
      originalChatId: dto.originalChatId,
      sender: User.fromDto(dto.sender),
      originalCreatedAt: dto.originalCreatedAt,
      replyToMessage: dto.replyToMessage == null
          ? null
          : ReplyToMessage.fromDto(dto.replyToMessage!),
      content: _contentFromForwardedSnapshotDto(
        dto,
        attachments: attachments,
        mentions: mentions,
      ),
    );
  }

  final int originalMessageId;
  final int originalChatId;
  final User sender;
  final DateTime? originalCreatedAt;
  final ReplyToMessage? replyToMessage;
  final MessageContent content;
}

MessageContent _contentFromForwardedSnapshotDto(
  ForwardedMessageSnapshotDto dto, {
  required List<AttachmentItem> attachments,
  required List<MentionInfo> mentions,
}) {
  if (dto.messageType == 'sticker') {
    return TextMessageContent(text: '[Sticker]', mentions: mentions);
  }
  return _contentFromMessageItemDto(
    messageType: dto.messageType,
    message: dto.message,
    sticker: null,
    attachments: attachments,
    mentions: mentions,
    forwardedMessages: null,
  );
}

class SystemMessageContent extends MessageContent {
  const SystemMessageContent({required this.text});

  final String text;
}
