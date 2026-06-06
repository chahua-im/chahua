import 'package:chahua/features/chat_list/application/chat_list_v2_scope.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final chatWorkspaceListScopeProvider =
    NotifierProvider<ChatWorkspaceListScopeNotifier, ChatListV2Scope>(
      ChatWorkspaceListScopeNotifier.new,
    );

class ChatWorkspaceListScopeNotifier extends Notifier<ChatListV2Scope> {
  @override
  ChatListV2Scope build() => ChatListV2Scope.active;

  void select(ChatListV2Scope scope) => state = scope;
}
