import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/chat_list/application/all_list_v2_models.dart';
import 'package:chahua/features/chat_list/application/all_list_v2_projection.dart';
import 'package:chahua/features/chat_list/application/all_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/application/chat_list_v2_scope.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_store.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_store.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/presentation/widgets/chat_list_detail_navigation.dart';
import 'package:chahua/features/chat_list/presentation/widgets/group_list_v2_row.dart';
import 'package:chahua/features/chat_list/presentation/widgets/list_row_interaction_surface.dart';
import 'package:chahua/features/chat_list/presentation/widgets/thread_list_v2_row.dart';

class AllListV2View extends ConsumerWidget {
  const AllListV2View({
    super.key,
    this.scope = ChatListV2Scope.active,
    this.selectedChatId,
    this.selectedThreadRootId,
  });

  final ChatListV2Scope scope;
  final String? selectedChatId;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final items = ref.watch(allListV2ItemsProvider(scope));
    final uiState = ref.watch(allListV2ViewModelProvider(scope));
    final groupAsync = ref.watch(groupListV2ViewModelProvider(scope));
    final threadAsync = ref.watch(threadListV2ViewModelProvider(scope));
    final showArchiveFolder =
        scope == ChatListV2Scope.active &&
        ref.watch(_showAllArchivedFolderProvider);
    final isInitialLoading =
        items.isEmpty && groupAsync.isLoading && threadAsync.isLoading;

    if (isInitialLoading) {
      return const SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: CupertinoActivityIndicator()),
      );
    }

    if (uiState.errorMessage != null && items.isEmpty) {
      return SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: Text(uiState.errorMessage!)),
      );
    }

    if (items.isEmpty && !showArchiveFolder) {
      return SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: Text(l10n.noChatsOrThreadsYet)),
      );
    }

    return SliverMainAxisGroup(
      slivers: [
        SliverList.builder(
          itemCount: items.length + (showArchiveFolder ? 1 : 0),
          itemBuilder: (context, index) {
            if (showArchiveFolder && index == 0) {
              return const _AllArchivedFolderRow();
            }

            final itemIndex = showArchiveFolder ? index - 1 : index;
            return _AllListV2Row(
              item: items[itemIndex],
              scope: scope,
              selectedChatId: selectedChatId,
              selectedThreadRootId: selectedThreadRootId,
            );
          },
        ),
        if (uiState.isLoadingMore)
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(child: CupertinoActivityIndicator()),
            ),
          ),
      ],
    );
  }
}

final _showAllArchivedFolderProvider = Provider<bool>((ref) {
  final hasArchivedGroups = ref.watch(
    groupListV2StoreProvider.select((state) => state.hasArchivedGroups),
  );
  final hasArchivedThreads = ref.watch(
    threadListV2StoreProvider.select(
      (state) =>
          state.hasArchivedThreads ||
          state.unreadTotals.archivedThreadCount > 0,
    ),
  );
  return hasArchivedGroups || hasArchivedThreads;
});

class _AllArchivedFolderRow extends ConsumerWidget {
  const _AllArchivedFolderRow();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    return ListRowInteractionSurface(
      isActive: false,
      onTap: () => openArchivedChatList(context: context, ref: ref),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: CupertinoColors.systemGrey5.resolveFrom(context),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    CupertinoIcons.archivebox,
                    color: CupertinoColors.systemGrey.resolveFrom(context),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    l10n.archived,
                    style: appTextStyle(
                      context,
                      fontSize: AppFontSizes.body,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                const Icon(
                  CupertinoIcons.chevron_right,
                  size: 16,
                  color: CupertinoColors.systemGrey3,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 76),
            child: Container(
              height: 0.5,
              color: CupertinoColors.separator.resolveFrom(context),
            ),
          ),
        ],
      ),
    );
  }
}

class _AllListV2Row extends StatelessWidget {
  const _AllListV2Row({
    required this.item,
    required this.scope,
    required this.selectedChatId,
    required this.selectedThreadRootId,
  });

  final AllListV2Item item;
  final ChatListV2Scope scope;
  final String? selectedChatId;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context) {
    return switch (item) {
      AllGroupListV2Item(:final group) => GroupListV2Row(
        chat: group,
        scope: scope,
        isActive: group.id == selectedChatId,
      ),
      AllThreadListV2Item(:final thread) => ThreadListV2Row(
        thread: thread,
        scope: scope,
        isActive: thread.threadRootId == selectedThreadRootId,
      ),
    };
  }
}
