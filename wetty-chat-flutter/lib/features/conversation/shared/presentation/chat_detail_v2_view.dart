import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/presentation/conversation_surface_v2.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_store.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_layout_scope.dart';

class ChatDetailV2Page extends StatelessWidget {
  const ChatDetailV2Page({
    super.key,
    required this.chatId,
    this.launchRequest = const LaunchRequest.latest(),
    this.showBackButton = false,
  });

  final int chatId;
  final LaunchRequest launchRequest;
  final bool showBackButton;

  @override
  Widget build(BuildContext context) {
    final isSplitLayout = ChatWorkspaceLayoutScope.isSplitLayout(context);
    final ConversationIdentity identity = (chatId: chatId, threadRootId: null);
    return CupertinoPageScaffold(
      resizeToAvoidBottomInset: false,
      navigationBar: CupertinoNavigationBar(
        automaticallyImplyLeading: showBackButton || !isSplitLayout,
        middle: _ChatDetailTitle(chatId: chatId),
        trailing: _ChatDetailActions(chatId: chatId),
      ),
      child: SafeArea(
        bottom: false,
        child: ConversationSurfaceV2(
          identity: identity,
          launchRequest: launchRequest,
          onOpenThread: (message) => _openThread(context, message),
          onStartThread: (message) => _startThread(context, message),
        ),
      ),
    );
  }

  void _openThread(BuildContext context, ConversationMessageV2 message) {
    final threadRootId = message.serverMessageId;
    if (threadRootId == null) {
      return;
    }
    context.push(AppRoutes.nestedThreadDetail('$chatId', '$threadRootId'));
  }

  void _startThread(BuildContext context, ConversationMessageV2 message) {
    final threadRootId = message.serverMessageId;
    if (threadRootId == null) {
      return;
    }
    context.push(AppRoutes.nestedNewThread('$chatId', '$threadRootId'));
  }
}

class _ChatDetailActions extends StatelessWidget {
  const _ChatDetailActions({required this.chatId});

  static const _buttonSize = Size.square(36);
  static const _iconSize = 26.0;

  final int chatId;

  @override
  Widget build(BuildContext context) {
    final routeChatId = chatId.toString();

    return Row(
      mainAxisSize: MainAxisSize.min,
      spacing: 8,
      children: [
        CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 0),
          minimumSize: _buttonSize,
          onPressed: () => context.push(AppRoutes.chatMembers(routeChatId)),
          child: const Icon(CupertinoIcons.person_2_fill, size: _iconSize),
        ),
        CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 0),
          minimumSize: _buttonSize,
          onPressed: () => context.push(AppRoutes.chatSettings(routeChatId)),
          child: const Icon(CupertinoIcons.info_circle, size: _iconSize),
        ),
      ],
    );
  }
}

class _ChatDetailTitle extends ConsumerWidget {
  const _ChatDetailTitle({required this.chatId});

  final int chatId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final group = ref.watch(groupByIdProvider(chatId.toString()));
    final resolvedName = group?.name?.trim();
    final title = resolvedName != null && resolvedName.isNotEmpty
        ? resolvedName
        : 'Chat $chatId';
    return Text(title);
  }
}
