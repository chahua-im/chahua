import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/l10n/app_localizations.dart';

import '../../../app/routing/route_names.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import '../../shared/presentation/chat_timestamp_formatter.dart';
import 'chat_workspace_layout_scope.dart';
import 'widgets/chat_list_row.dart';
import 'widgets/swipe_to_action_row.dart';
import '../model/chat_list_item.dart';
import '../model/thread_list_item.dart';
import 'widgets/thread_list_row.dart';
import '../application/all_list_v2_models.dart';
import '../application/all_list_v2_projection.dart';
import '../application/all_list_v2_view_model.dart';
import '../application/group_list_v2_view_model.dart';
import '../application/thread_list_v2_view_model.dart';

class AllListV2View extends ConsumerWidget {
  const AllListV2View({
    super.key,
    this.selectedChatId,
    this.selectedThreadRootId,
  });

  final String? selectedChatId;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final items = ref.watch(allListV2ItemsProvider);
    final uiState = ref.watch(allListV2ViewModelProvider);
    final groupAsync = ref.watch(groupListV2ViewModelProvider);
    final threadAsync = ref.watch(activeThreadListV2ViewModelProvider);
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

    if (items.isEmpty) {
      return SliverFillRemaining(
        hasScrollBody: false,
        child: Center(child: Text(l10n.noChatsOrThreadsYet)),
      );
    }

    return SliverMainAxisGroup(
      slivers: [
        SliverList.builder(
          itemCount: items.length,
          itemBuilder: (context, index) => _AllListV2Row(
            item: items[index],
            selectedChatId: selectedChatId,
            selectedThreadRootId: selectedThreadRootId,
          ),
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

class _AllListV2Row extends StatelessWidget {
  const _AllListV2Row({
    required this.item,
    required this.selectedChatId,
    required this.selectedThreadRootId,
  });

  final AllListV2Item item;
  final String? selectedChatId;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context) {
    return switch (item) {
      AllGroupListV2Item(:final group) => _AllGroupListV2Row(
        group: group,
        isActive: group.id == selectedChatId,
      ),
      AllThreadListV2Item(:final thread) => _AllThreadListV2Row(
        thread: thread,
        isActive: thread.threadRootId == selectedThreadRootId,
      ),
    };
  }
}

class _AllGroupListV2Row extends StatelessWidget {
  const _AllGroupListV2Row({required this.group, required this.isActive});

  final ChatListItem group;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    final chatName = group.name?.isNotEmpty == true
        ? group.name!
        : AppLocalizations.of(context)!.chatFallbackName(group.id);
    final dateText = formatChatListTimestamp(context, group.lastMessageAt);
    final lastMessage = group.lastMessage;
    final isMuted =
        group.mutedUntil != null && group.mutedUntil!.isAfter(DateTime.now());
    final isUnread = group.unreadCount > 0;

    return Consumer(
      builder: (context, ref, _) => SwipeToActionRow(
        key: ValueKey('group-all-v2-${group.id}'),
        icon: isUnread ? CupertinoIcons.checkmark_alt : CupertinoIcons.mail,
        label: isUnread
            ? AppLocalizations.of(context)!.swipeActionMarkRead
            : AppLocalizations.of(context)!.swipeActionMarkUnread,
        onAction: () => ref
            .read(groupListV2ViewModelProvider.notifier)
            .toggleGroupReadState(chatId: group.id),
        child: ChatListRow(
          chatName: chatName,
          avatarUrl: group.avatarUrl,
          timestampText: dateText,
          unreadCount: group.unreadCount,
          senderName: lastMessage?.sender.name,
          lastMessageText: _messagePreviewText(
            lastMessage,
            AppLocalizations.of(context)!,
          ),
          isActive: isActive,
          isMuted: isMuted,
          onTap: () {
            context.go(
              AppRoutes.chatDetail(group.id),
              extra: {
                'launchRequest': _launchRequestForChat(group),
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

  static LaunchRequest _launchRequestForChat(ChatListItem chat) {
    final lastReadMessageId = int.tryParse(chat.lastReadMessageId ?? '');
    if (chat.unreadCount <= 0 || lastReadMessageId == null) {
      return const LaunchRequest.latest();
    }
    return LaunchRequest.unread(lastReadMessageId: lastReadMessageId);
  }

  static String _messagePreviewText(
    MessagePreview? message,
    AppLocalizations l10n,
  ) {
    if (message == null) {
      return '';
    }
    return formatMessagePreview(
      message: message.message,
      messageType: message.messageType,
      sticker: message.sticker,
      attachments: message.attachments,
      firstAttachmentKind: message.firstAttachmentKind,
      isDeleted: message.isDeleted,
      mentions: message.mentions,
      l10n: l10n,
    );
  }
}

class _AllThreadListV2Row extends StatelessWidget {
  const _AllThreadListV2Row({required this.thread, required this.isActive});

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
