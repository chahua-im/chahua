import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/chat_list/presentation/widgets/chat_list_detail_navigation.dart';
import 'package:chahua/features/chat_list/presentation/widgets/list_row_interaction_surface.dart';
import 'package:chahua/features/chat_list/presentation/widgets/unread_badge_formatter.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class ChatListArchivedFolderRow extends ConsumerWidget {
  const ChatListArchivedFolderRow({
    super.key,
    required this.title,
    this.subtitle,
    this.unreadCount = 0,
  });

  final String title;
  final String? subtitle;
  final int unreadCount;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
                  child: _ArchivedFolderText(title: title, subtitle: subtitle),
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

class _ArchivedFolderText extends StatelessWidget {
  const _ArchivedFolderText({required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final subtitle = this.subtitle;
    if (subtitle == null) {
      return Text(
        title,
        style: appTextStyle(
          context,
          fontSize: AppFontSizes.body,
          fontWeight: FontWeight.w600,
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          title,
          style: appTextStyle(
            context,
            fontSize: AppFontSizes.body,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          subtitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: appTextStyle(
            context,
            fontSize: AppFontSizes.meta,
            color: CupertinoColors.secondaryLabel.resolveFrom(context),
          ),
        ),
      ],
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
        formatUnreadBadgeCount(count),
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
