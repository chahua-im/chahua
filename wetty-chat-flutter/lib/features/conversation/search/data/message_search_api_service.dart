import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/network/dio_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class MessageSearchApiService {
  MessageSearchApiService(this._dio);

  final Dio _dio;

  Future<SearchMessagesResponseDto> searchMessages(
    int chatId, {
    required String query,
    int limit = 20,
    int offset = 0,
  }) async {
    final response = await _dio.get<Map<String, dynamic>>(
      '/chats/$chatId/messages/search',
      queryParameters: <String, Object>{
        'q': query,
        'limit': limit,
        'offset': offset,
      },
    );
    return SearchMessagesResponseDto.fromJson(response.data!);
  }
}

final messageSearchApiServiceProvider = Provider<MessageSearchApiService>((
  ref,
) {
  return MessageSearchApiService(ref.watch(dioProvider));
});
