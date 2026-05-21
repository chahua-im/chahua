import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/l10n/app_localizations.dart';

import '../../../app/routing/route_names.dart';
import 'chat_workspace_layout_scope.dart';
import 'package:chahua/features/chat_list/presentation/widgets/swipe_to_action_row.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import '../../shared/presentation/chat_timestamp_formatter.dart';
import 'widgets/chat_list_row.dart';
import '../model/chat_list_item.dart';
import '../application/chat_list_v2_scope.dart';
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
        if (viewState.errorMessage != null && viewState.groups.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(viewState.errorMessage!)),
          );
        }
        if (viewState.groups.isEmpty) {
          return SliverFillRemaining(
            hasScrollBody: false,
            child: Center(child: Text(l10n.noGroupsYet)),
          );
        }

        return SliverMainAxisGroup(
          slivers: [
            SliverList.builder(
              itemCount: viewState.groups.length,
              itemBuilder: (context, index) {
                final chat = viewState.groups[index];
                return _GroupListV2Row(
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

class _GroupListV2Row extends StatelessWidget {
  const _GroupListV2Row({
    required this.chat,
    required this.scope,
    required this.isActive,
  });

  final ChatListItem chat;
  final ChatListV2Scope scope;
  final bool isActive;

  @override
  Widget build(BuildContext context) {
    final chatName = chat.name?.isNotEmpty == true
        ? chat.name!
        : AppLocalizations.of(context)!.chatFallbackName(chat.id);
    final dateText = formatChatListTimestamp(context, chat.lastMessageAt);
    final lastMessage = chat.lastMessage;
    final isMuted =
        chat.mutedUntil != null && chat.mutedUntil!.isAfter(DateTime.now());
    final isUnread = chat.unreadCount > 0;
    final l10n = AppLocalizations.of(context)!;
    final provider = groupListV2ViewModelProvider(scope);

    return Consumer(
      builder: (context, ref, _) => SwipeToActionRow(
        key: ValueKey('group-v2-${chat.id}'),
        icon: isUnread ? CupertinoIcons.checkmark_alt : CupertinoIcons.mail,
        label: isUnread ? l10n.swipeActionMarkRead : l10n.swipeActionMarkUnread,
        onAction: () =>
            ref.read(provider.notifier).toggleGroupReadState(chatId: chat.id),
        secondaryIcon: CupertinoIcons.archivebox,
        secondaryLabel: switch (scope) {
          ChatListV2Scope.active => l10n.swipeActionArchive,
          ChatListV2Scope.archived => l10n.swipeActionUnarchive,
        },
        secondaryActionColor: switch (scope) {
          ChatListV2Scope.active => CupertinoColors.systemOrange,
          ChatListV2Scope.archived => CupertinoColors.systemGreen,
        },
        secondaryOnAction: () => switch (scope) {
          ChatListV2Scope.active =>
            ref.read(provider.notifier).archiveGroup(chat),
          ChatListV2Scope.archived =>
            ref.read(provider.notifier).unarchiveGroup(chat),
        },
        child: ChatListRow(
          chatName: chatName,
          avatarUrl: chat.avatarUrl,
          timestampText: dateText,
          unreadCount: chat.unreadCount,
          senderName: lastMessage?.sender.name,
          lastMessageText: _messagePreviewText(
            lastMessage,
            AppLocalizations.of(context)!,
          ),
          isActive: isActive,
          isMuted: isMuted,
          onTap: () {
            context.go(
              AppRoutes.chatDetail(chat.id),
              extra: {
                'launchRequest': _launchRequestForChat(chat),
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
