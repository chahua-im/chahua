import 'dart:async';
import 'dart:developer';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class ConversationOutboundMessageQueue {
  ConversationOutboundMessageQueue(this.ref, this.identity);

  final Ref ref;
  final ConversationIdentity identity;
  final _pendingRequests = <_OutboundMessageSendRequest>[];
  final _requestsByClientGeneratedId = <String, _OutboundMessageSendRequest>{};
  var _isDraining = false;
  var _nextLocalSendOrder = 0;

  ConversationTimelineMessageStore get _store =>
      ref.read(conversationTimelineMessageStoreProvider.notifier);

  Future<void> enqueue({
    required ConversationMessageV2 optimisticMessage,
    required List<String> attachmentIds,
  }) async {
    final localSendOrder = _nextLocalSendOrder++;
    final message = optimisticMessage.copyWith(
      deliveryState: ConversationDeliveryState.sending,
      localSendOrder: localSendOrder,
    );
    final request = _OutboundMessageSendRequest(
      message: message,
      attachmentIds: attachmentIds,
    );
    _requestsByClientGeneratedId[message.clientGeneratedId] = request;
    _pendingRequests.add(request);
    _store.newMessage(identity, message);
    unawaited(_drain());
  }

  void retryFailed(String clientGeneratedId) {
    if (_pendingRequests.any(
      (request) => request.clientGeneratedId == clientGeneratedId,
    )) {
      return;
    }

    final failedMessage = _store.messageForClientGeneratedId(
      identity,
      clientGeneratedId,
    );
    if (failedMessage == null ||
        failedMessage.serverMessageId != null ||
        failedMessage.deliveryState != ConversationDeliveryState.failed) {
      return;
    }

    final existingRequest = _requestsByClientGeneratedId[clientGeneratedId];
    if (existingRequest == null) {
      return;
    }

    final retryMessage = failedMessage.copyWith(
      deliveryState: ConversationDeliveryState.sending,
    );
    _store.updateLocalMessage(identity, retryMessage);
    final retryRequest = existingRequest.copyWith(message: retryMessage);
    _requestsByClientGeneratedId[clientGeneratedId] = retryRequest;
    _pendingRequests.add(retryRequest);
    unawaited(_drain());
  }

  void discardFailed(String clientGeneratedId) {
    _pendingRequests.removeWhere(
      (request) => request.clientGeneratedId == clientGeneratedId,
    );
    _requestsByClientGeneratedId.remove(clientGeneratedId);
    _store.discardLocalMessage(identity, clientGeneratedId);
  }

  Future<void> _drain() async {
    if (_isDraining) {
      return;
    }
    _isDraining = true;
    try {
      while (_pendingRequests.isNotEmpty) {
        final request = _pendingRequests.removeAt(0);
        if (!_markInFlight(request)) {
          continue;
        }
        try {
          final response = await _post(request);
          _requestsByClientGeneratedId.remove(request.clientGeneratedId);
          _store.newMessage(
            identity,
            ConversationMessageV2.fromMessageItemDto(response),
          );
        } catch (error, stackTrace) {
          log(
            'outbound send failed: identity=$identity '
            'clientId=${request.clientGeneratedId}',
            name: 'ConversationTimeline',
            error: error,
            stackTrace: stackTrace,
          );
          _markFailed(request);
        }
      }
    } finally {
      _isDraining = false;
      if (_pendingRequests.isNotEmpty) {
        unawaited(_drain());
      }
    }
  }

  bool _markInFlight(_OutboundMessageSendRequest request) {
    final current = _store.messageForClientGeneratedId(
      identity,
      request.clientGeneratedId,
    );
    if (current == null || current.serverMessageId != null) {
      return false;
    }
    _store.updateLocalMessage(
      identity,
      current.copyWith(deliveryState: ConversationDeliveryState.sending),
    );
    return true;
  }

  void _markFailed(_OutboundMessageSendRequest request) {
    final current = _store.messageForClientGeneratedId(
      identity,
      request.clientGeneratedId,
    );
    if (current == null || current.serverMessageId != null) {
      return;
    }
    _store.updateLocalMessage(
      identity,
      current.copyWith(deliveryState: ConversationDeliveryState.failed),
    );
  }

  Future<MessageItemDto> _post(_OutboundMessageSendRequest request) {
    final message = request.message;
    return ref
        .read(messageApiServiceV2Provider)
        .sendConversationMessage(
          identity,
          _textFor(message),
          messageType: _messageTypeFor(message),
          replyToId: message.replyToMessage?.id,
          attachmentIds: request.attachmentIds,
          clientGeneratedId: message.clientGeneratedId,
          stickerId: _stickerIdFor(message),
        );
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
}

class _OutboundMessageSendRequest {
  const _OutboundMessageSendRequest({
    required this.message,
    required this.attachmentIds,
  });

  final ConversationMessageV2 message;
  final List<String> attachmentIds;

  String get clientGeneratedId => message.clientGeneratedId;

  _OutboundMessageSendRequest copyWith({
    ConversationMessageV2? message,
    List<String>? attachmentIds,
  }) {
    return _OutboundMessageSendRequest(
      message: message ?? this.message,
      attachmentIds: attachmentIds ?? this.attachmentIds,
    );
  }
}

final conversationOutboundMessageQueueProvider =
    Provider.family<ConversationOutboundMessageQueue, ConversationIdentity>(
      ConversationOutboundMessageQueue.new,
    );
