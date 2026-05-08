import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../all_list_v2_view.dart';
import '../group_list_v2_view.dart';
import '../thread_list_v2_view.dart';
import '../../application/chat_list_v2_scope.dart';
import 'chat_list_segment.dart';

class ChatListV2TabBody extends ConsumerWidget {
  const ChatListV2TabBody({
    super.key,
    this.scope = ChatListV2Scope.active,
    required this.activeTab,
    this.selectedChatId,
    this.selectedThreadRootId,
  });

  final ChatListV2Scope scope;
  final ChatListTab activeTab;
  final String? selectedChatId;
  final int? selectedThreadRootId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (activeTab) {
      ChatListTab.groups => GroupListV2View(
        scope: scope,
        selectedChatId: selectedThreadRootId == null ? selectedChatId : null,
      ),
      ChatListTab.threads => ThreadListV2View(
        scope: scope,
        selectedThreadRootId: selectedThreadRootId,
      ),
      ChatListTab.all => AllListV2View(
        scope: scope,
        selectedChatId: selectedThreadRootId == null ? selectedChatId : null,
        selectedThreadRootId: selectedThreadRootId,
      ),
    };
  }
}
