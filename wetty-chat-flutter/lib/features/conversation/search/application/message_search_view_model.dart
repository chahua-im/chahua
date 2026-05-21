import 'package:chahua/core/api/models/messages_api_models.dart' as api_models;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/message_search_api_service.dart';
import '../domain/message_search_state.dart';
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
    final generation = ++_generation;

    if (!_isQueryReady(normalizedQuery)) {
      state = AsyncData(
        MessageSearchState(
          query: normalizedQuery,
          results: const [],
          status: MessageSearchStatus.idle,
        ),
      );
      return;
    }

    state = AsyncData(
      MessageSearchState(
        query: normalizedQuery,
        results: const [],
        status: MessageSearchStatus.searching,
      ),
    );

    try {
      final response = await ref
          .read(messageSearchApiServiceProvider)
          .searchMessages(arg, query: normalizedQuery, limit: pageSize);
      if (generation != _generation) {
        return;
      }
      state = AsyncData(
        MessageSearchState(
          query: normalizedQuery,
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
