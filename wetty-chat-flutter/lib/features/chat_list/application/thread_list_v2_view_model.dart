import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/features/shared/data/read_state_repository.dart';

import '../data/thread_list_v2_repository.dart';
import '../model/thread_list_item.dart';
import 'thread_list_v2_store.dart';

enum ThreadListV2Scope { active, archived }

typedef ThreadListV2ViewState = ({
  List<ThreadListItem> threads,
  bool hasMore,
  bool isLoadingMore,
  bool isRefreshing,
  bool isLoading,
  String? errorMessage,
});

class ThreadListV2ViewModel extends AsyncNotifier<ThreadListV2ViewState> {
  ThreadListV2ViewModel(this.scope);

  final ThreadListV2Scope scope;

  @override
  Future<ThreadListV2ViewState> build() async {
    ref.listen<ThreadListV2StoreState>(threadListV2StoreProvider, (_, _) {
      _rebuildFromStore();
    });
    return _loadInitial();
  }

  Future<ThreadListV2ViewState> _loadInitial() async {
    switch (scope) {
      case ThreadListV2Scope.active:
        await Future.wait([
          ref.read(threadListV2RepositoryProvider).loadThreads(),
          ref.read(threadListV2RepositoryProvider).probeArchivedThreads(),
        ]);
      case ThreadListV2Scope.archived:
        final archived = ref.read(threadListV2StoreProvider).archived;
        if (!archived.isLoaded) {
          await ref.read(threadListV2RepositoryProvider).loadArchivedThreads();
        }
    }

    final listState = _currentListState();
    return (
      threads: listState.threads,
      hasMore: listState.hasMore,
      isLoadingMore: false,
      isRefreshing: false,
      isLoading: false,
      errorMessage: null,
    );
  }

  void _rebuildFromStore() {
    final current = state.value;
    if (current == null) {
      return;
    }
    final listState = _currentListState();
    state = AsyncData((
      threads: listState.threads,
      hasMore: listState.hasMore,
      isLoadingMore: current.isLoadingMore,
      isRefreshing: current.isRefreshing,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
  }

  Future<void> loadMoreThreads() async {
    final current = state.value;
    if (current == null) {
      return;
    }
    if (!current.hasMore || current.isLoadingMore || current.threads.isEmpty) {
      return;
    }

    state = AsyncData((
      threads: current.threads,
      hasMore: current.hasMore,
      isLoadingMore: true,
      isRefreshing: current.isRefreshing,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
    try {
      switch (scope) {
        case ThreadListV2Scope.active:
          await ref.read(threadListV2RepositoryProvider).loadMoreThreads();
        case ThreadListV2Scope.archived:
          await ref
              .read(threadListV2RepositoryProvider)
              .loadMoreArchivedThreads();
      }
    } catch (_) {
      // Silently fail pagination.
    } finally {
      final listState = _currentListState();
      final latest = state.value;
      if (latest != null) {
        state = AsyncData((
          threads: listState.threads,
          hasMore: listState.hasMore,
          isLoadingMore: false,
          isRefreshing: latest.isRefreshing,
          isLoading: false,
          errorMessage: latest.errorMessage,
        ));
      }
    }
  }

  Future<void> refreshThreads() async {
    final current = state.value;
    if (current == null) {
      return;
    }
    if (current.isLoadingMore || current.isRefreshing) {
      return;
    }

    state = AsyncData((
      threads: current.threads,
      hasMore: current.hasMore,
      isLoadingMore: current.isLoadingMore,
      isRefreshing: true,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
    try {
      final limit = current.threads.isEmpty ? 20 : current.threads.length;
      switch (scope) {
        case ThreadListV2Scope.active:
          await Future.wait([
            ref.read(threadListV2RepositoryProvider).loadThreads(limit: limit),
            ref.read(threadListV2RepositoryProvider).probeArchivedThreads(),
          ]);
          ref.read(readStateRepositoryProvider).resetThreadBaselines();
        case ThreadListV2Scope.archived:
          await ref
              .read(threadListV2RepositoryProvider)
              .loadArchivedThreads(limit: limit);
      }

      final listState = _currentListState();
      state = AsyncData((
        threads: listState.threads,
        hasMore: listState.hasMore,
        isLoadingMore: false,
        isRefreshing: false,
        isLoading: false,
        errorMessage: null,
      ));
    } catch (error) {
      final latest = state.value;
      if (latest != null) {
        state = AsyncData((
          threads: latest.threads,
          hasMore: latest.hasMore,
          isLoadingMore: false,
          isRefreshing: false,
          isLoading: false,
          errorMessage: error.toString(),
        ));
      }
    }
  }

  ThreadListV2ListState _currentListState() {
    final storeState = ref.read(threadListV2StoreProvider);
    return switch (scope) {
      ThreadListV2Scope.active => storeState.active,
      ThreadListV2Scope.archived => storeState.archived,
    };
  }
}

final threadListV2ViewModelProvider =
    AsyncNotifierProvider.family<
      ThreadListV2ViewModel,
      ThreadListV2ViewState,
      ThreadListV2Scope
    >(ThreadListV2ViewModel.new);

final activeThreadListV2ViewModelProvider = threadListV2ViewModelProvider(
  ThreadListV2Scope.active,
);

final archivedThreadListV2ViewModelProvider = threadListV2ViewModelProvider(
  ThreadListV2Scope.archived,
);
