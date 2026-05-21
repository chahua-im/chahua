import 'package:chahua/core/api/models/messages_api_models.dart';

import 'message_search_target.dart';

enum MessageSearchStatus { idle, searching, ready, error }

class MessageSearchResult {
  const MessageSearchResult({required this.message, required this.target});

  final MessageItemDto message;
  final MessageSearchTarget target;
}

class MessageSearchState {
  const MessageSearchState({
    required this.query,
    required this.results,
    required this.status,
    this.nextOffset,
    this.isLoadingMore = false,
    this.error,
  });

  const MessageSearchState.initial()
    : query = '',
      results = const [],
      status = MessageSearchStatus.idle,
      nextOffset = null,
      isLoadingMore = false,
      error = null;

  final String query;
  final List<MessageSearchResult> results;
  final MessageSearchStatus status;
  final int? nextOffset;
  final bool isLoadingMore;
  final Object? error;

  bool get hasMore => nextOffset != null;

  MessageSearchState copyWith({
    String? query,
    List<MessageSearchResult>? results,
    MessageSearchStatus? status,
    Object? nextOffset = _sentinel,
    bool? isLoadingMore,
    Object? error = _sentinel,
  }) {
    return MessageSearchState(
      query: query ?? this.query,
      results: results ?? this.results,
      status: status ?? this.status,
      nextOffset: nextOffset == _sentinel
          ? this.nextOffset
          : nextOffset as int?,
      isLoadingMore: isLoadingMore ?? this.isLoadingMore,
      error: error == _sentinel ? this.error : error,
    );
  }
}

const Object _sentinel = Object();
