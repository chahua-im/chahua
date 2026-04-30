import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'group_list_v2_view_model.dart';
import 'thread_list_v2_view_model.dart';

typedef AllListV2UiState = ({
  bool isRefreshing,
  bool isLoadingMore,
  String? errorMessage,
});

class AllListV2ViewModel extends Notifier<AllListV2UiState> {
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
        ref.read(groupListV2ViewModelProvider.notifier).refreshGroups(),
        ref.read(activeThreadListV2ViewModelProvider.notifier).refreshThreads(),
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

    final groupState = ref.read(groupListV2ViewModelProvider).value;
    final threadState = ref.read(activeThreadListV2ViewModelProvider).value;
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
        if (groupsHasMore)
          ref.read(groupListV2ViewModelProvider.notifier).loadMoreGroups(),
        if (threadsHasMore)
          ref
              .read(activeThreadListV2ViewModelProvider.notifier)
              .loadMoreThreads(),
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
    NotifierProvider<AllListV2ViewModel, AllListV2UiState>(
      AllListV2ViewModel.new,
    );
