import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/features/chat_list/application/chat_list_v2_scope.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/model/thread_list_item.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_layout_scope.dart';
import 'package:chahua/features/chat_list/presentation/widgets/swipe_to_action_row.dart';
import 'package:chahua/features/chat_list/presentation/widgets/thread_list_row.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

class ThreadListV2Row extends StatelessWidget {
  const ThreadListV2Row({
    super.key,
    required this.scope,
    required this.thread,
    required this.isActive,
  });

  final ChatListV2Scope scope;
  final ThreadListItem thread;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final provider = threadListV2ViewModelProvider(scope);
    return Consumer(
      builder: (context, ref, _) => SwipeToActionRow(
        key: ValueKey('thread-v2-${thread.chatId}-${thread.threadRootId}'),
        direction: SwipeToActionDirection.left,
        icon: CupertinoIcons.archivebox,
        label: switch (scope) {
          ChatListV2Scope.active => l10n.swipeActionArchive,
          ChatListV2Scope.archived => l10n.swipeActionUnarchive,
        },
        actionColor: switch (scope) {
          ChatListV2Scope.active => CupertinoColors.systemOrange,
          ChatListV2Scope.archived => CupertinoColors.systemGreen,
        },
        onAction: () => switch (scope) {
          ChatListV2Scope.active =>
            ref.read(provider.notifier).archiveThread(thread),
          ChatListV2Scope.archived =>
            ref.read(provider.notifier).unarchiveThread(thread),
        },
        child: ThreadListRow(
          thread: thread,
          isActive: isActive,
          onTap: () {
            context.go(
              AppRoutes.threadDetail(
                thread.chatId,
                thread.threadRootId.toString(),
              ),
              extra: {
                'disableTransition': ChatWorkspaceLayoutScope.isSplitLayout(
                  context,
                ),
              },
            );
          },
        ),
      ),
    );
  }
}
