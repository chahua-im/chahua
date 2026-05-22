import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/l10n/app_localizations.dart';

import '../../../app/routing/route_names.dart';
import 'chat_workspace_layout_scope.dart';
import 'package:chahua/features/chat_list/presentation/widgets/group_list_v2_row.dart';
import 'widgets/list_row_interaction_surface.dart';
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
        final showArchiveFolder =
            scope == ChatListV2Scope.active && hasArchivedGroups;

        if (viewState.errorMessage != null && viewState.groups.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(viewState.errorMessage!)),
          );
        }
        if (viewState.groups.isEmpty && !showArchiveFolder) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(l10n.noGroupsYet)),
          );
        }

        return SliverMainAxisGroup(
          slivers: [
            SliverList.builder(
              itemCount: viewState.groups.length + (showArchiveFolder ? 1 : 0),
              itemBuilder: (context, index) {
                if (showArchiveFolder && index == 0) {
                  return const _ArchivedGroupsFolderRow();
                }

                final groupIndex = showArchiveFolder ? index - 1 : index;
                final chat = viewState.groups[groupIndex];
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
    return ListRowInteractionSurface(
      isActive: false,
      onTap: () {
        context.push(
          AppRoutes.archivedChats,
          extra: {
            'disableTransition': ChatWorkspaceLayoutScope.isSplitLayout(
              context,
            ),
          },
        );
      },
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
                    l10n.archivedGroups,
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
