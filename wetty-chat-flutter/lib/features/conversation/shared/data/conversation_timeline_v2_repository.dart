import 'dart:async';
import 'dart:developer';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_canonical_scope.dart';
import 'package:chahua/features/shared/data/read_state_repository.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class ConversationTimelineV2Repository {
  ConversationTimelineV2Repository(this.ref, this.identity);

  final Ref ref;
  final ConversationIdentity identity;

  ConversationTimelineMessageStore get _store =>
      ref.read(conversationTimelineMessageStoreProvider.notifier);

  Future<void> sendMessage({
    required ConversationMessageV2 optimisticMessage,
    // TODO(conversation_v2): remove this once transport can derive uploaded
    // attachment ids directly from the optimistic message payload.
    required List<String> attachmentIds,
  }) async {
    log(
      'sendMessage optimistic insert: identity=$identity '
      'clientId=${optimisticMessage.clientGeneratedId} '
      'serverId=${optimisticMessage.serverMessageId} '
      'type=${_messageTypeFor(optimisticMessage)}',
      name: 'ConversationTimeline',
    );
    // Optimistically insert the message into the timeline.
    _store.newMessage(identity, optimisticMessage);

    try {
      final response = await ref
          .read(messageApiServiceV2Provider)
          .sendConversationMessage(
            identity,
            _textFor(optimisticMessage),
            messageType: _messageTypeFor(optimisticMessage),
            replyToId: optimisticMessage.replyToMessage?.id,
            attachmentIds: attachmentIds,
            clientGeneratedId: optimisticMessage.clientGeneratedId,
            stickerId: _stickerIdFor(optimisticMessage),
          );
      _store.newMessage(
        identity,
        ConversationMessageV2.fromMessageItemDto(response),
      );
      log(
        'sendMessage post accepted: identity=$identity '
        'clientId=${optimisticMessage.clientGeneratedId}',
        name: 'ConversationTimeline',
      );
    } catch (error, stackTrace) {
      final current = _store.messageForClientGeneratedId(
        identity,
        optimisticMessage.clientGeneratedId,
      );
      if (current != null && current.serverMessageId == null) {
        _store.updateLocalMessage(
          identity,
          current.copyWith(deliveryState: ConversationDeliveryState.failed),
        );
      }
      log(
        'sendMessage post failed: identity=$identity '
        'clientId=${optimisticMessage.clientGeneratedId}',
        name: 'ConversationTimeline',
        error: error,
        stackTrace: stackTrace,
      );
      rethrow;
    }
  }

  Future<void> toggleReaction({
    required int messageId,
    required String emoji,
  }) async {
    final message = _store.messageForServerMessageId(identity, messageId);
    if (message == null) {
      throw StateError('Message not found: $messageId');
    }
    if (message.content is StickerMessageContent) {
      throw UnsupportedError('Sticker reactions are not supported');
    }
    if (message.isDeleted) {
      throw StateError('Deleted messages cannot be reacted to');
    }

    final snapshot = message;
    final optimistic = snapshot.copyWith(
      reactions: _toggleReactionLocal(snapshot, emoji),
    );
    if (!_store.updateMessage(identity, optimistic)) {
      throw StateError('Message not found: $messageId');
    }

    try {
      final currentlyReacted = snapshot.reactions.any(
        (reaction) => reaction.emoji == emoji && reaction.reactedByMe == true,
      );
      if (currentlyReacted) {
        await ref
            .read(messageApiServiceV2Provider)
            .deleteReaction(identity, messageId, emoji);
      } else {
        await ref
            .read(messageApiServiceV2Provider)
            .putReaction(identity, messageId, emoji);
      }
    } catch (_) {
      _store.updateMessage(identity, snapshot);
      rethrow;
    }
  }

  Future<void> deleteMessage(int messageId) async {
    final message = _store.messageForServerMessageId(identity, messageId);
    if (message == null) {
      throw StateError('Message not found: $messageId');
    }
    if (message.isDeleted) {
      return;
    }

    final snapshot = message;
    final optimistic = snapshot.copyWith(
      isDeleted: true,
      deliveryState: ConversationDeliveryState.deleting,
    );
    if (!_store.updateMessage(identity, optimistic)) {
      throw StateError('Message not found: $messageId');
    }

    try {
      await ref
          .read(messageApiServiceV2Provider)
          .deleteMessage(identity.chatId, messageId);
      _store.updateMessage(
        identity,
        optimistic.copyWith(
          isDeleted: true,
          deliveryState: ConversationDeliveryState.confirmed,
        ),
      );
    } catch (_) {
      _store.updateMessage(identity, snapshot);
      rethrow;
    }
  }

  void markVisibleMessageRead(int messageId) {
    ref
        .read(readStateRepositoryProvider)
        .reportVisibleMessageRead(identity: identity, messageId: messageId);
  }

  String _messageTypeFor(ConversationMessageV2 message) {
    return switch (message.content) {
      TextMessageContent() => 'text',
      AudioMessageContent() => 'audio',
      StickerMessageContent() => 'sticker',
      InviteMessageContent() => 'invite',
      SystemMessageContent() => 'system',
    };
  }

  String _textFor(ConversationMessageV2 message) {
    return switch (message.content) {
      TextMessageContent(:final text) => text,
      AudioMessageContent(:final text) => text ?? '',
      InviteMessageContent(:final text) => text ?? '',
      SystemMessageContent(:final text) => text,
      StickerMessageContent() => '',
    };
  }

  String? _stickerIdFor(ConversationMessageV2 message) {
    return switch (message.content) {
      StickerMessageContent(:final sticker) => sticker.id,
      _ => null,
    };
  }

  List<ReactionSummary> _toggleReactionLocal(
    ConversationMessageV2 message,
    String emoji,
  ) {
    final next = <ReactionSummary>[];
    var handled = false;
    for (final reaction in message.reactions) {
      if (reaction.emoji != emoji) {
        next.add(reaction);
        continue;
      }
      handled = true;
      final currentlyReacted = reaction.reactedByMe == true;
      final updatedCount = currentlyReacted
          ? reaction.count - 1
          : reaction.count + 1;
      if (updatedCount <= 0) {
        continue;
      }
      next.add(
        ReactionSummary(
          emoji: reaction.emoji,
          count: updatedCount,
          reactedByMe: currentlyReacted ? false : true,
          reactors: reaction.reactors,
        ),
      );
    }

    if (!handled) {
      next.add(ReactionSummary(emoji: emoji, count: 1, reactedByMe: true));
    }

    return next;
  }

  Future<void> refreshLatestSegment({required int limit}) async {
    final response = await ref
        .read(messageApiServiceV2Provider)
        .fetchConversationMessages(identity, max: limit);
    final hasMoreOlder = response.nextCursor != null;

    if (response.messages.isEmpty) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .putScope(
            identity,
            const ConversationTimelineCanonicalScope(
              hasReachedLatest: true,
              hasReachedOldest: true,
            ),
          );
      return;
    }

    final latestSegment = ConversationTimelineCanonicalSegment(
      orderedMessages: response.messages
          .map(ConversationMessageV2.fromMessageItemDto)
          .toList(growable: false),
    );

    ref
        .read(conversationTimelineMessageStoreProvider.notifier)
        .insertLatestSegment(identity, latestSegment);

    if (!hasMoreOlder) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedOldest(identity);
    }
  }

  Future<void> loadOlderBeforeAnchor(
    int anchorServerMessageId, {
    required int limit,
  }) {
    return _loadOlderBeforeAnchor(anchorServerMessageId, limit: limit);
  }

  Future<void> loadNewerAfterAnchor(
    int anchorServerMessageId, {
    required int limit,
  }) {
    return _loadNewerAfterAnchor(anchorServerMessageId, limit: limit);
  }

  Future<int?> refreshAroundServerMessageId(
    int targetServerMessageId, {
    required int limit,
  }) {
    return _refreshAroundServerMessageId(targetServerMessageId, limit: limit);
  }

  Future<int?> refreshUnreadAroundReadBoundary(
    int lastReadMessageId, {
    required int limit,
  }) {
    return _refreshAroundReadBoundary(lastReadMessageId, limit: limit);
  }

  Future<void> _loadOlderBeforeAnchor(
    int anchorServerMessageId, {
    required int limit,
  }) async {
    final response = await ref
        .read(messageApiServiceV2Provider)
        .fetchConversationMessages(
          identity,
          before: anchorServerMessageId,
          max: limit,
        );
    final hasMoreOlder = response.nextCursor != null;

    if (response.messages.isEmpty) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedOldest(identity);
      return;
    }

    ref
        .read(conversationTimelineMessageStoreProvider.notifier)
        .insertBeforeAnchor(
          identity,
          anchorServerMessageId,
          ConversationTimelineCanonicalSegment(
            orderedMessages: response.messages
                .map(ConversationMessageV2.fromMessageItemDto)
                .toList(growable: false),
          ),
        );

    if (!hasMoreOlder) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedOldest(identity);
    }
  }

  Future<void> _loadNewerAfterAnchor(
    int anchorServerMessageId, {
    required int limit,
  }) async {
    final response = await ref
        .read(messageApiServiceV2Provider)
        .fetchConversationMessages(
          identity,
          after: anchorServerMessageId,
          max: limit,
        );
    final hasMoreNewer = response.prevCursor != null;
    final hasReachedLatest = !hasMoreNewer;

    if (response.messages.isNotEmpty) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .insertAfterAnchor(
            identity,
            anchorServerMessageId,
            ConversationTimelineCanonicalSegment(
              orderedMessages: response.messages
                  .map(ConversationMessageV2.fromMessageItemDto)
                  .toList(growable: false),
            ),
            hasReachedLatest: hasReachedLatest,
          );
      return;
    }

    if (hasReachedLatest) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedLatest(identity);
    }
  }

  Future<int?> _refreshAroundServerMessageId(
    int targetServerMessageId, {
    required int limit,
  }) async {
    final response = await ref
        .read(messageApiServiceV2Provider)
        .fetchConversationMessages(
          identity,
          around: targetServerMessageId,
          max: limit,
        );
    final hasMoreOlder = response.nextCursor != null;
    final hasMoreNewer = response.prevCursor != null;
    final hasReachedLatest = !hasMoreNewer;

    if (response.messages.isEmpty) {
      return null;
    }

    final resolvedAnchorMessageId = _nearestRenderableAroundAnchor(
      response.messages,
      targetServerMessageId,
    );

    ref
        .read(conversationTimelineMessageStoreProvider.notifier)
        .insertAround(
          identity,
          ConversationTimelineCanonicalSegment(
            orderedMessages: response.messages
                .map(ConversationMessageV2.fromMessageItemDto)
                .toList(growable: false),
          ),
          hasReachedLatest: hasReachedLatest,
        );

    if (!hasMoreOlder) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedOldest(identity);
    }

    return resolvedAnchorMessageId;
  }

  Future<int?> _refreshAroundReadBoundary(
    int lastReadMessageId, {
    required int limit,
  }) async {
    final response = await ref
        .read(messageApiServiceV2Provider)
        .fetchConversationMessages(
          identity,
          around: lastReadMessageId,
          max: limit,
        );
    final hasMoreOlder = response.nextCursor != null;
    final hasMoreNewer = response.prevCursor != null;
    final hasReachedLatest = !hasMoreNewer;

    if (response.messages.isEmpty) {
      return null;
    }

    ref
        .read(conversationTimelineMessageStoreProvider.notifier)
        .insertAround(
          identity,
          ConversationTimelineCanonicalSegment(
            orderedMessages: response.messages
                .map(ConversationMessageV2.fromMessageItemDto)
                .toList(growable: false),
          ),
          hasReachedLatest: hasReachedLatest,
        );

    if (!hasMoreOlder) {
      ref
          .read(conversationTimelineMessageStoreProvider.notifier)
          .markReachedOldest(identity);
    }

    for (final message in response.messages) {
      if (message.id > lastReadMessageId) {
        return message.id;
      }
    }
    return response.messages.first.id;
  }

  int _nearestRenderableAroundAnchor(
    List<MessageItemDto> messages,
    int targetServerMessageId,
  ) {
    for (final message in messages) {
      if (message.id >= targetServerMessageId) {
        return message.id;
      }
    }
    return messages.last.id;
  }
}

final conversationTimelineV2RepositoryProvider =
    Provider.family<ConversationTimelineV2Repository, ConversationIdentity>(
      (ref, identity) => ConversationTimelineV2Repository(ref, identity),
    );
