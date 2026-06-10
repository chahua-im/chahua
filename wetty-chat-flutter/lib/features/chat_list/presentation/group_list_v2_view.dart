import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:chahua/l10n/app_localizations.dart';

import 'package:chahua/features/chat_list/presentation/widgets/chat_list_archived_folder_row.dart';
import 'package:chahua/features/chat_list/presentation/widgets/group_list_v2_row.dart';
import '../application/chat_list_v2_scope.dart';
import '../application/group_list_v2_store.dart';
import '../application/group_list_v2_view_model.dart';

class GroupListV2View extends ConsumerWidget {
  const GroupListV2View({
    super.key,
    this.scope = ChatListV2Scope.active,
    this.selectedChatId,
  });

  final ChatListV2Scope scope;
  final String? selectedChatId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final provider = groupListV2ViewModelProvider(scope);
    final asyncState = ref.watch(provider);
    final listState = ref.watch(
      groupListV2StoreProvider.select(
        (state) => switch (scope) {
          ChatListV2Scope.active => state.active,
          ChatListV2Scope.archived => state.archived,
        },
      ),
    );
    final hasArchivedGroups = ref.watch(
      groupListV2StoreProvider.select((state) => state.hasArchivedGroups),
    );

    return asyncState.when(
      loading: () => const SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: CupertinoActivityIndicator()),
      ),
      error: (error, _) => SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: Text(error.toString())),
      ),
      data: (viewState) {
        final groups = listState.groups;
        final showArchiveFolder =
            scope == ChatListV2Scope.active && hasArchivedGroups;

        if (viewState.errorMessage != null && groups.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(viewState.errorMessage!)),
          );
        }
        if (groups.isEmpty && !showArchiveFolder) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(l10n.noGroupsYet)),
          );
        }

        return SliverMainAxisGroup(
          slivers: [
            SliverList.builder(
              itemCount: groups.length + (showArchiveFolder ? 1 : 0),
              itemBuilder: (context, index) {
                if (showArchiveFolder && index == 0) {
                  return const _ArchivedGroupsFolderRow();
                }

                final groupIndex = showArchiveFolder ? index - 1 : index;
                final chat = groups[groupIndex];
                return GroupListV2Row(
                  chat: chat,
                  scope: scope,
                  isActive: chat.id == selectedChatId,
                );
              },
            ),
            if (viewState.isLoadingMore)
              const SliverToBoxAdapter(
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Center(child: CupertinoActivityIndicator()),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _ArchivedGroupsFolderRow extends StatelessWidget {
  const _ArchivedGroupsFolderRow();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return ChatListArchivedFolderRow(
      title: l10n.archivedGroups,
      // TODO: pass archived group unread count.
    );
  }
}
