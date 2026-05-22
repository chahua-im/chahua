import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'chat_list_v2_scope.dart';
import 'group_list_v2_view_model.dart';
import 'thread_list_v2_view_model.dart';

typedef AllListV2UiState = ({
  bool isRefreshing,
  bool isLoadingMore,
  String? errorMessage,
});

class AllListV2ViewModel extends Notifier<AllListV2UiState> {
  AllListV2ViewModel(this.scope);

  final ChatListV2Scope scope;

  @override
  AllListV2UiState build() {
    return (isRefreshing: false, isLoadingMore: false, errorMessage: null);
  }

  Future<void> refreshAll() async {
    final current = state;
    if (current.isRefreshing || current.isLoadingMore) {
      return;
    }

    state = (
      isRefreshing: true,
      isLoadingMore: false,
      errorMessage: current.errorMessage,
    );

    try {
      await Future.wait([
        ref.read(groupListV2ViewModelProvider(scope).notifier).refreshGroups(),
        ref
            .read(threadListV2ViewModelProvider(scope).notifier)
            .refreshThreads(),
      ]);
      state = (isRefreshing: false, isLoadingMore: false, errorMessage: null);
    } catch (error) {
      state = (
        isRefreshing: false,
        isLoadingMore: false,
        errorMessage: error.toString(),
      );
    }
  }

  Future<void> loadMoreAll() async {
    final current = state;
    if (current.isRefreshing || current.isLoadingMore) {
      return;
    }

    final groupProvider = groupListV2ViewModelProvider(scope);
    final threadProvider = threadListV2ViewModelProvider(scope);
    final groupState = ref.read(groupProvider).value;
    final threadState = ref.read(threadProvider).value;
    final groupsHasMore = groupState?.hasMore ?? false;
    final threadsHasMore = threadState?.hasMore ?? false;
    if (!groupsHasMore && !threadsHasMore) {
      return;
    }

    state = (
      isRefreshing: current.isRefreshing,
      isLoadingMore: true,
      errorMessage: current.errorMessage,
    );

    try {
      await Future.wait([
        if (groupsHasMore) ref.read(groupProvider.notifier).loadMoreGroups(),
        if (threadsHasMore) ref.read(threadProvider.notifier).loadMoreThreads(),
      ]);
    } finally {
      state = (
        isRefreshing: state.isRefreshing,
        isLoadingMore: false,
        errorMessage: state.errorMessage,
      );
    }
  }
}

final allListV2ViewModelProvider =
    NotifierProvider.family<
      AllListV2ViewModel,
      AllListV2UiState,
      ChatListV2Scope
    >(AllListV2ViewModel.new);
