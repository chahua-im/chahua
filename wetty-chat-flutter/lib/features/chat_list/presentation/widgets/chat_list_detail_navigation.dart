import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/features/chat_list/application/chat_list_v2_scope.dart';
import 'package:chahua/features/chat_list/application/chat_workspace_list_scope.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_layout_scope.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

void openChatListDetail({
  required BuildContext context,
  required WidgetRef ref,
  required ChatListV2Scope scope,
  required String route,
  Object? extra,
}) {
  final isSplit = ChatWorkspaceLayoutScope.isSplitLayout(context);
  if (!isSplit) {
    context.push(route, extra: extra);
    return;
  }
  ref.read(chatWorkspaceListScopeProvider.notifier).select(scope);
  context.go(route, extra: extra);
}

void openArchivedChatList({
  required BuildContext context,
  required WidgetRef ref,
}) {
  final isSplit = ChatWorkspaceLayoutScope.isSplitLayout(context);
  if (isSplit) {
    ref
        .read(chatWorkspaceListScopeProvider.notifier)
        .select(ChatListV2Scope.archived);
    return;
  }
  context.push(AppRoutes.archivedChats, extra: {'disableTransition': isSplit});
}
