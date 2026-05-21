import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/features/shared/data/read_state_repository.dart';
import '../model/chat_list_item.dart';
import '../data/group_list_v2_repository.dart';
import 'chat_list_v2_scope.dart';
import 'group_list_v2_store.dart';

typedef GroupListV2ViewState = ({
  List<ChatListItem> groups,
  bool hasMore,
  bool isLoadingMore,
  bool isRefreshing,
  bool isLoading,
  String? errorMessage,
});

class GroupListV2ViewModel extends AsyncNotifier<GroupListV2ViewState> {
  GroupListV2ViewModel(this.scope);

  final ChatListV2Scope scope;

  @override
  Future<GroupListV2ViewState> build() async {
    ref.listen<GroupListV2StoreState>(groupListV2StoreProvider, (_, _) {
      _rebuildFromStore();
    });
    return _loadInitial();
  }

  Future<GroupListV2ViewState> _loadInitial() async {
    switch (scope) {
      case ChatListV2Scope.active:
        await Future.wait([
          ref.read(groupListV2RepositoryProvider).loadGroups(),
          ref.read(groupListV2RepositoryProvider).probeArchivedGroups(),
        ]);
      case ChatListV2Scope.archived:
        final archived = ref.read(groupListV2StoreProvider).archived;
        if (!archived.isLoaded) {
          await ref.read(groupListV2RepositoryProvider).loadArchivedGroups();
        }
    }

    final listState = _currentListState();
    return (
      groups: listState.groups,
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
      groups: listState.groups,
      hasMore: listState.hasMore,
      isLoadingMore: current.isLoadingMore,
      isRefreshing: current.isRefreshing,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
  }

  Future<void> loadMoreGroups() async {
    final current = state.value;
    if (current == null) {
      return;
    }
    if (!current.hasMore || current.isLoadingMore || current.groups.isEmpty) {
      return;
    }

    state = AsyncData((
      groups: current.groups,
      hasMore: current.hasMore,
      isLoadingMore: true,
      isRefreshing: current.isRefreshing,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
    try {
      switch (scope) {
        case ChatListV2Scope.active:
          await ref.read(groupListV2RepositoryProvider).loadMoreGroups();
        case ChatListV2Scope.archived:
          await ref
              .read(groupListV2RepositoryProvider)
              .loadMoreArchivedGroups();
      }
    } catch (_) {
      // Silently fail pagination.
    } finally {
      final listState = _currentListState();
      final latest = state.value;
      if (latest != null) {
        state = AsyncData((
          groups: listState.groups,
          hasMore: listState.hasMore,
          isLoadingMore: false,
          isRefreshing: latest.isRefreshing,
          isLoading: false,
          errorMessage: latest.errorMessage,
        ));
      }
    }
  }

  Future<void> refreshGroups() async {
    final current = state.value;
    if (current == null) {
      return;
    }
    if (current.isLoadingMore || current.isRefreshing) {
      return;
    }

    state = AsyncData((
      groups: current.groups,
      hasMore: current.hasMore,
      isLoadingMore: current.isLoadingMore,
      isRefreshing: true,
      isLoading: false,
      errorMessage: current.errorMessage,
    ));
    try {
      switch (scope) {
        case ChatListV2Scope.active:
          await Future.wait([
            ref.read(groupListV2RepositoryProvider).loadGroups(),
            ref.read(groupListV2RepositoryProvider).probeArchivedGroups(),
          ]);
          ref.read(readStateRepositoryProvider).resetChatBaselines();
        case ChatListV2Scope.archived:
          await ref.read(groupListV2RepositoryProvider).loadArchivedGroups();
      }

      final listState = _currentListState();
      state = AsyncData((
        groups: listState.groups,
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
          groups: latest.groups,
          hasMore: latest.hasMore,
          isLoadingMore: false,
          isRefreshing: false,
          isLoading: false,
          errorMessage: error.toString(),
        ));
      }
    }
  }

  Future<void> toggleGroupReadState({required String chatId}) async {
    final group = _currentListState().groups
        .where((group) => group.id == chatId)
        .firstOrNull;
    if (group == null) {
      return;
    }

    if (group.unreadCount > 0) {
      final lastMessageId = group.lastMessage?.messageId;
      if (lastMessageId == null) {
        return;
      }
      final response = await ref
          .read(readStateRepositoryProvider)
          .markChatRead(chatId: chatId, messageId: lastMessageId);
      ref
          .read(groupListV2StoreProvider.notifier)
          .applyServerReadState(
            chatId: chatId,
            messageId: lastMessageId,
            response: response,
          );
      return;
    }

    final response = await ref
        .read(readStateRepositoryProvider)
        .markChatUnread(chatId: chatId);
    ref
        .read(groupListV2StoreProvider.notifier)
        .applyServerReadState(chatId: chatId, response: response);
  }

  Future<void> archiveGroup(ChatListItem group) async {
    await ref.read(groupListV2RepositoryProvider).archiveGroup(group);
  }

  Future<void> unarchiveGroup(ChatListItem group) async {
    await ref.read(groupListV2RepositoryProvider).unarchiveGroup(group);
  }

  GroupListV2ListState _currentListState() {
    final storeState = ref.read(groupListV2StoreProvider);
    return switch (scope) {
      ChatListV2Scope.active => storeState.active,
      ChatListV2Scope.archived => storeState.archived,
    };
  }
}

final groupListV2ViewModelProvider =
    AsyncNotifierProvider.family<
      GroupListV2ViewModel,
      GroupListV2ViewState,
      ChatListV2Scope
    >(GroupListV2ViewModel.new);

/// View model for the normal Groups tab.
///
/// Loads active groups and probes archived-group existence for the archive
/// folder row.
final activeGroupListV2ViewModelProvider = groupListV2ViewModelProvider(
  ChatListV2Scope.active,
);

/// View model for the archived Groups tab.
///
/// Loads and paginates only archived groups.
final archivedGroupListV2ViewModelProvider = groupListV2ViewModelProvider(
  ChatListV2Scope.archived,
);
