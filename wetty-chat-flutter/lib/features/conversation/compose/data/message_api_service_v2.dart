import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/models/chats_api_models.dart';
import '../../../../core/api/models/messages_api_models.dart';
import '../../../../core/network/dio_client.dart';
import '../../../../core/session/dev_session_store.dart';
import '../../../conversation/shared/domain/conversation_identity.dart';

class MessageApiServiceV2 {
  MessageApiServiceV2(this._dio, this._currentUserId);

  final Dio _dio;
  final int _currentUserId;

  String nextClientGeneratedId({String? seed}) {
    return '${DateTime.now().microsecondsSinceEpoch}-$seed-$_currentUserId';
  }

  String _sendPath(ConversationIdentity identity) {
    if (identity.threadRootId == null) {
      return '/chats/${identity.chatId}/messages';
    }
    return '/chats/${identity.chatId}/threads/${identity.threadRootId}/messages';
  }

  Future<ListMessagesResponseDto> fetchConversationMessages(
    ConversationIdentity identity, {
    int? max,
    int? before,
    int? after,
    int? around,
  }) async {
    final query = <String, String>{};
    if (max != null) query['max'] = max.toString();
    if (before != null) query['before'] = before.toString();
    if (after != null) query['after'] = after.toString();
    if (around != null) query['around'] = around.toString();
    if (identity.threadRootId != null) {
      query['threadId'] = identity.threadRootId!.toString();
    }

    final response = await _dio.get<Map<String, dynamic>>(
      '/chats/${identity.chatId}/messages',
      queryParameters: query.isEmpty ? null : query,
    );
    return ListMessagesResponseDto.fromJson(response.data!);
  }

  Future<MessageItemDto> sendConversationMessage(
    ConversationIdentity identity,
    String text, {
    required String messageType,
    int? replyToId,
    List<String> attachmentIds = const <String>[],
    required String clientGeneratedId,
    String? stickerId,
  }) async {
    final body = SendMessageRequestDto(
      message: text,
      messageType: messageType,
      clientGeneratedId: clientGeneratedId,
      attachmentIds: attachmentIds,
      replyToId: replyToId,
      stickerId: stickerId,
    );
    final response = await _dio.post<Map<String, dynamic>>(
      _sendPath(identity),
      data: body.toJson(),
    );
    return MessageItemDto.fromJson(response.data!);
  }

  Future<Map<String, dynamic>> forwardMessages({
    required int sourceChatId,
    required int destinationChatId,
    required List<int> messageIds,
  }) async {
    final body = ForwardMessagesRequestDto(
      sourceChatId: sourceChatId.toString(),
      messageIds: messageIds.map((id) => id.toString()).toList(growable: false),
    );
    final response = await _dio.post<Map<String, dynamic>>(
      '/chats/$destinationChatId/messages/forward',
      data: body.toJson(),
    );
    return response.data ?? <String, dynamic>{};
  }

  Future<MessageItemDto> editMessage(
    int chatId,
    int messageId,
    String newText, {
    List<String> attachmentIds = const <String>[],
  }) async {
    final response = await _dio.patch<Map<String, dynamic>>(
      '/chats/$chatId/messages/$messageId',
      data: EditMessageRequestDto(
        message: newText,
        attachmentIds: attachmentIds,
      ).toJson(),
    );
    return MessageItemDto.fromJson(response.data!);
  }

  Future<void> deleteMessage(int chatId, int messageId) async {
    await _dio.delete<void>('/chats/$chatId/messages/$messageId');
  }

  Future<void> putReaction(
    ConversationIdentity identity,
    int messageId,
    String emoji,
  ) async {
    await _dio.put<void>(
      '/chats/${identity.chatId}/messages/$messageId/reactions/${Uri.encodeComponent(emoji)}',
    );
  }

  Future<void> deleteReaction(
    ConversationIdentity identity,
    int messageId,
    String emoji,
  ) async {
    await _dio.delete<void>(
      '/chats/${identity.chatId}/messages/$messageId/reactions/${Uri.encodeComponent(emoji)}',
    );
  }

  Future<MarkChatReadStateResponseDto> markMessagesAsRead(
    String chatId,
    int messageId,
  ) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/chats/$chatId/read',
      data: MarkReadRequestDto(messageId: messageId).toJson(),
    );
    return MarkChatReadStateResponseDto.fromJson(response.data!);
  }
}

final messageApiServiceV2Provider = Provider<MessageApiServiceV2>((ref) {
  final session = ref.watch(authSessionProvider);
  return MessageApiServiceV2(ref.watch(dioProvider), session.currentUserId);
});
