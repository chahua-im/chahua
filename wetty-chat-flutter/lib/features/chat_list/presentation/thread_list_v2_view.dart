import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/l10n/app_localizations.dart';

import '../../../app/routing/route_names.dart';
import '../../../app/theme/style_config.dart';
import '../application/thread_list_v2_store.dart';
import '../model/thread_list_item.dart';
import 'chat_workspace_layout_scope.dart';
import 'widgets/list_row_interaction_surface.dart';
import 'widgets/thread_list_row.dart';
import '../application/thread_list_v2_view_model.dart';

class ThreadListV2View extends ConsumerWidget {
  const ThreadListV2View({super.key, this.selectedThreadRootId});

  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final asyncState = ref.watch(activeThreadListV2ViewModelProvider);
    final archivedSummary = ref.watch(
      threadListV2StoreProvider.select(
        (state) => (
          hasArchivedThreads: state.hasArchivedThreads,
          unreadCount: state.unreadTotals.archivedThreadCount,
        ),
      ),
    );

    return asyncState.when(
      loading: () => const SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: CupertinoActivityIndicator()),
      ),
      error: (error, _) => SliverFillRemaining(
        hasScrollBody: false,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(error.toString(), textAlign: TextAlign.center),
              const SizedBox(height: 16),
              CupertinoButton.filled(
                onPressed: () =>
                    ref.invalidate(activeThreadListV2ViewModelProvider),
                child: Text(l10n.retry),
              ),
            ],
          ),
        ),
      ),
      data: (viewState) {
        if (viewState.errorMessage != null && viewState.threads.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(viewState.errorMessage!, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  CupertinoButton.filled(
                    onPressed: () =>
                        ref.invalidate(activeThreadListV2ViewModelProvider),
                    child: Text(l10n.retry),
                  ),
                ],
              ),
            ),
          );
        }

        final showArchiveFolder =
            archivedSummary.hasArchivedThreads ||
            archivedSummary.unreadCount > 0;

        if (viewState.threads.isEmpty && !showArchiveFolder) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(
                l10n.noThreadsYet,
                style: appSecondaryTextStyle(context),
              ),
            ),
          );
        }

        return SliverMainAxisGroup(
          slivers: [
            SliverList.builder(
              itemCount: viewState.threads.length + (showArchiveFolder ? 1 : 0),
              itemBuilder: (context, index) {
                if (showArchiveFolder && index == 0) {
                  return _ArchivedThreadsFolderRow(
                    unreadCount: archivedSummary.unreadCount,
                  );
                }

                final threadIndex = showArchiveFolder ? index - 1 : index;
                final thread = viewState.threads[threadIndex];
                return _ThreadListV2Row(
                  thread: thread,
                  isActive: thread.threadRootId == selectedThreadRootId,
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

class _ArchivedThreadsFolderRow extends StatelessWidget {
  const _ArchivedThreadsFolderRow({required this.unreadCount});

  final int unreadCount;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return ListRowInteractionSurface(
      isActive: false,
      onTap: () => context.go(AppRoutes.archivedThreads),
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
                    l10n.archivedThreads,
                    style: appTextStyle(
                      context,
                      fontSize: AppFontSizes.body,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (unreadCount > 0) _UnreadBadge(count: unreadCount),
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

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 8),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: CupertinoColors.systemRed,
        borderRadius: BorderRadius.circular(10),
      ),
      constraints: const BoxConstraints(minWidth: 20),
      child: Text(
        count > 99 ? '99+' : '$count',
        textAlign: TextAlign.center,
        style: appOnDarkTextStyle(
          context,
          fontSize: AppFontSizes.unreadBadge,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _ThreadListV2Row extends StatelessWidget {
  const _ThreadListV2Row({required this.thread, required this.isActive});

  final ThreadListItem thread;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    return ThreadListRow(
      thread: thread,
      isActive: isActive,
      onTap: () {
        context.go(
          AppRoutes.threadDetail(thread.chatId, thread.threadRootId.toString()),
          extra: {
            'disableTransition': ChatWorkspaceLayoutScope.isSplitLayout(
              context,
            ),
          },
        );
      },
    );
  }
}
