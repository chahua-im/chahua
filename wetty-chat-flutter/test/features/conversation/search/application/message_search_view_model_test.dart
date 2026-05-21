import 'dart:async';
import 'dart:collection';

import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/search/application/message_search_view_model.dart';
import 'package:chahua/features/conversation/search/data/message_search_api_service.dart';
import 'package:chahua/features/conversation/search/domain/message_search_state.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('MessageSearchViewModel', () {
    test(
      'does not call the API for queries shorter than two characters',
      () async {
        final api = _FakeMessageSearchApiService();
        final container = _container(api);
        addTearDown(container.dispose);

        await container
            .read(messageSearchViewModelProvider(42).notifier)
            .updateQuery('  a ');

        final state = container.read(messageSearchViewModelProvider(42)).value!;
        expect(api.requests, isEmpty);
        expect(state.query, 'a');
        expect(state.results, isEmpty);
        expect(state.status, MessageSearchStatus.idle);
      },
    );

    test(
      'trims query and stores result targets for root and thread messages',
      () async {
        final api = _FakeMessageSearchApiService(
          responses: [
            SearchMessagesResponseDto(
              messages: [_message(10), _message(11, replyRootId: 8)],
              nextOffset: 20,
            ),
          ],
        );
        final container = _container(api);
        addTearDown(container.dispose);

        await container
            .read(messageSearchViewModelProvider(42).notifier)
            .updateQuery('  hello  ');

        final state = container.read(messageSearchViewModelProvider(42)).value!;
        expect(api.requests, [
          const _SearchRequest(
            chatId: 42,
            query: 'hello',
            limit: 20,
            offset: 0,
          ),
        ]);
        expect(state.status, MessageSearchStatus.ready);
        expect(state.query, 'hello');
        expect(state.hasMore, true);
        expect(state.results.map((result) => result.message.id), [10, 11]);
        expect(state.results.first.target.threadRootId, isNull);
        expect(state.results.last.target.threadRootId, 8);
      },
    );

    test(
      'ignores stale responses when a newer search finishes first',
      () async {
        final first = Completer<SearchMessagesResponseDto>();
        final second = Completer<SearchMessagesResponseDto>();
        final api = _FakeMessageSearchApiService(completers: [first, second]);
        final container = _container(api);
        addTearDown(container.dispose);
        final notifier = container.read(
          messageSearchViewModelProvider(42).notifier,
        );

        final firstSearch = notifier.updateQuery('hello');
        final secondSearch = notifier.updateQuery('world');
        second.complete(
          SearchMessagesResponseDto(messages: [_message(2)], nextOffset: null),
        );
        await secondSearch;
        first.complete(
          SearchMessagesResponseDto(messages: [_message(1)], nextOffset: null),
        );
        await firstSearch;

        final state = container.read(messageSearchViewModelProvider(42)).value!;
        expect(state.query, 'world');
        expect(state.results.map((result) => result.message.id), [2]);
      },
    );

    test('loadMore appends the next offset page', () async {
      final api = _FakeMessageSearchApiService(
        responses: [
          SearchMessagesResponseDto(messages: [_message(1)], nextOffset: 20),
          SearchMessagesResponseDto(messages: [_message(2)], nextOffset: null),
        ],
      );
      final container = _container(api);
      addTearDown(container.dispose);
      final notifier = container.read(
        messageSearchViewModelProvider(42).notifier,
      );

      await notifier.updateQuery('hello');
      await notifier.loadMore();

      final state = container.read(messageSearchViewModelProvider(42)).value!;
      expect(api.requests, [
        const _SearchRequest(chatId: 42, query: 'hello', limit: 20, offset: 0),
        const _SearchRequest(chatId: 42, query: 'hello', limit: 20, offset: 20),
      ]);
      expect(state.results.map((result) => result.message.id), [1, 2]);
      expect(state.hasMore, false);
    });

    test('resets state after the search page listener is disposed', () async {
      final api = _FakeMessageSearchApiService(
        responses: [
          SearchMessagesResponseDto(messages: [_message(1)], nextOffset: null),
        ],
      );
      final container = _container(api);
      addTearDown(container.dispose);
      final provider = messageSearchViewModelProvider(42);
      final subscription = container.listen(
        provider,
        (_, _) {},
        fireImmediately: true,
      );

      await container.read(provider.notifier).updateQuery('hello');
      expect(container.read(provider).value!.results, isNotEmpty);

      subscription.close();
      await container.pump();

      final state = container.read(provider).value!;
      expect(state.query, isEmpty);
      expect(state.results, isEmpty);
      expect(state.status, MessageSearchStatus.idle);
    });
  });
}

ProviderContainer _container(_FakeMessageSearchApiService api) {
  return ProviderContainer(
    overrides: [messageSearchApiServiceProvider.overrideWithValue(api)],
  );
}

MessageItemDto _message(int id, {int? replyRootId}) {
  return MessageItemDto(
    id: id,
    sender: const UserDto(uid: 7, gender: 0),
    chatId: 42,
    clientGeneratedId: 'client-$id',
    message: 'message $id',
    replyRootId: replyRootId,
  );
}

final class _SearchRequest {
  const _SearchRequest({
    required this.chatId,
    required this.query,
    required this.limit,
    required this.offset,
  });

  final int chatId;
  final String query;
  final int limit;
  final int offset;

  @override
  bool operator ==(Object other) {
    return other is _SearchRequest &&
        other.chatId == chatId &&
        other.query == query &&
        other.limit == limit &&
        other.offset == offset;
  }

  @override
  int get hashCode => Object.hash(chatId, query, limit, offset);

  @override
  String toString() {
    return '_SearchRequest(chatId: $chatId, query: $query, '
        'limit: $limit, offset: $offset)';
  }
}

class _FakeMessageSearchApiService extends MessageSearchApiService {
  _FakeMessageSearchApiService({
    List<SearchMessagesResponseDto> responses = const [],
    List<Completer<SearchMessagesResponseDto>> completers = const [],
  }) : _responses = Queue.of(responses),
       _completers = Queue.of(completers),
       super(Dio());

  final Queue<SearchMessagesResponseDto> _responses;
  final Queue<Completer<SearchMessagesResponseDto>> _completers;
  final List<_SearchRequest> requests = [];

  @override
  Future<SearchMessagesResponseDto> searchMessages(
    int chatId, {
    required String query,
    int limit = 20,
    int offset = 0,
  }) async {
    requests.add(
      _SearchRequest(
        chatId: chatId,
        query: query,
        limit: limit,
        offset: offset,
      ),
    );
    if (_completers.isNotEmpty) {
      return _completers.removeFirst().future;
    }
    return _responses.removeFirst();
  }
}
