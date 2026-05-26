import 'package:chahua/core/api/models/messages_api_models.dart' as api_models;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/message_search_api_service.dart';
import '../domain/message_search_state.dart';
import '../domain/message_search_sort.dart';
import '../domain/message_search_target.dart';

class MessageSearchViewModel extends AsyncNotifier<MessageSearchState> {
  MessageSearchViewModel(this.arg);

  static const int pageSize = 20;

  final int arg;
  int _generation = 0;

  @override
  MessageSearchState build() {
    return const MessageSearchState.initial();
  }

  Future<void> updateQuery(String query) async {
    final normalizedQuery = query.trim();
    final sort = state.value?.sort ?? MessageSearchSort.best;

    if (!_isQueryReady(normalizedQuery)) {
      _generation += 1;
      state = AsyncData(
        MessageSearchState(
          query: normalizedQuery,
          sort: sort,
          results: const [],
          status: MessageSearchStatus.idle,
        ),
      );
      return;
    }

    await _search(query: normalizedQuery, sort: sort);
  }

  Future<void> updateSort(MessageSearchSort sort) async {
    final current = state.value ?? const MessageSearchState.initial();
    if (current.sort == sort) {
      return;
    }

    if (!_isQueryReady(current.query)) {
      _generation += 1;
      state = AsyncData(
        current.copyWith(
          sort: sort,
          results: const [],
          status: MessageSearchStatus.idle,
          nextOffset: null,
          isLoadingMore: false,
          error: null,
        ),
      );
      return;
    }

    await _search(query: current.query, sort: sort);
  }

  Future<void> _search({
    required String query,
    required MessageSearchSort sort,
  }) async {
    final generation = ++_generation;
    state = AsyncData(
      MessageSearchState(
        query: query,
        sort: sort,
        results: const [],
        status: MessageSearchStatus.searching,
      ),
    );

    try {
      final response = await ref
          .read(messageSearchApiServiceProvider)
          .searchMessages(arg, query: query, sort: sort, limit: pageSize);
      if (generation != _generation) {
        return;
      }
      state = AsyncData(
        MessageSearchState(
          query: query,
          sort: sort,
          results: _toResults(response.messages),
          status: MessageSearchStatus.ready,
          nextOffset: response.nextOffset,
        ),
      );
    } catch (error, stackTrace) {
      if (generation != _generation) {
        return;
      }
      state = AsyncError(error, stackTrace);
    }
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        current.nextOffset == null ||
        current.isLoadingMore ||
        !_isQueryReady(current.query)) {
      return;
    }

    final generation = _generation;
    state = AsyncData(current.copyWith(isLoadingMore: true));

    try {
      final response = await ref
          .read(messageSearchApiServiceProvider)
          .searchMessages(
            arg,
            query: current.query,
            sort: current.sort,
            limit: pageSize,
            offset: current.nextOffset!,
          );
      if (generation != _generation) {
        return;
      }
      state = AsyncData(
        current.copyWith(
          results: [...current.results, ..._toResults(response.messages)],
          status: MessageSearchStatus.ready,
          nextOffset: response.nextOffset,
          isLoadingMore: false,
          error: null,
        ),
      );
    } catch (error) {
      if (generation != _generation) {
        return;
      }
      final latest = state.value ?? current;
      state = AsyncData(latest.copyWith(isLoadingMore: false, error: error));
    }
  }

  List<MessageSearchResult> _toResults(
    Iterable<api_models.MessageItemDto> messages,
  ) {
    return [
      for (final message in messages)
        MessageSearchResult(
          message: message,
          target: MessageSearchTarget.fromMessage(
            chatId: arg,
            message: message,
          ),
        ),
    ];
  }

  bool _isQueryReady(String query) => query.runes.length >= 2;
}

final messageSearchViewModelProvider = AsyncNotifierProvider.autoDispose
    .family<MessageSearchViewModel, MessageSearchState, int>(
      MessageSearchViewModel.new,
    );
