import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/l10n/app_localizations.dart';

import '../../../app/theme/style_config.dart';
import '../application/chat_list_v2_scope.dart';
import '../application/thread_list_v2_store.dart';
import 'widgets/chat_list_archived_folder_row.dart';
import 'package:chahua/features/chat_list/presentation/widgets/thread_list_v2_row.dart';
import '../application/thread_list_v2_view_model.dart';

class ThreadListV2View extends ConsumerWidget {
  const ThreadListV2View({
    super.key,
    this.scope = ChatListV2Scope.active,
    this.selectedThreadRootId,
  });

  final ChatListV2Scope scope;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final provider = threadListV2ViewModelProvider(scope);
    final asyncState = ref.watch(provider);
    final hasArchivedThreads = ref.watch(
      threadListV2StoreProvider.select((state) => state.hasArchivedThreads),
    );
    final archivedUnreadCount = ref.watch(
      unreadBadgeProvider.select(
        (state) => state.archivedThreadUnreadItemCount,
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
                onPressed: () => ref.invalidate(provider),
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
                    onPressed: () => ref.invalidate(provider),
                    child: Text(l10n.retry),
                  ),
                ],
              ),
            ),
          );
        }

        final showArchiveFolder =
            scope == ChatListV2Scope.active &&
            (hasArchivedThreads || archivedUnreadCount > 0);

        if (viewState.threads.isEmpty && !showArchiveFolder) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(
              child: Text(switch (scope) {
                ChatListV2Scope.active => l10n.noThreadsYet,
                ChatListV2Scope.archived => l10n.noArchivedThreads,
              }, style: appSecondaryTextStyle(context)),
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
                    unreadCount: archivedUnreadCount,
                  );
                }

                final threadIndex = showArchiveFolder ? index - 1 : index;
                final thread = viewState.threads[threadIndex];
                return ThreadListV2Row(
                  scope: scope,
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
    return ChatListArchivedFolderRow(
      title: l10n.archivedThreads,
      unreadCount: unreadCount,
    );
  }
}
