import 'package:chahua/features/conversation/search/data/message_search_api_service.dart';
import 'package:chahua/features/conversation/search/domain/message_search_sort.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('MessageSearchApiService', () {
    test('sends backend sort wire values', () async {
      final recordedRequests = <RequestOptions>[];
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test'));
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            recordedRequests.add(options);
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                statusCode: 200,
                data: const {'messages': [], 'nextOffset': null},
              ),
            );
          },
        ),
      );
      final service = MessageSearchApiService(dio);

      await service.searchMessages(
        42,
        query: 'hello',
        sort: MessageSearchSort.best,
      );
      await service.searchMessages(
        42,
        query: 'hello',
        sort: MessageSearchSort.recent,
      );

      expect(
        recordedRequests.map((request) => request.queryParameters['sort']),
        ['relevance', 'newest'],
      );
    });
  });
}
