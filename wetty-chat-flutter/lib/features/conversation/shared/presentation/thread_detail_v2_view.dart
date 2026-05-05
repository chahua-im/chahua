import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/shared/presentation/conversation_surface_v2.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_layout_scope.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class ThreadDetailV2Page extends ConsumerStatefulWidget {
  const ThreadDetailV2Page({
    super.key,
    required this.chatId,
    required this.threadRootId,
    this.launchRequest = const LaunchRequest.latest(),
    this.isNewThread = false,
    this.implyLeadingInSplit = false,
  });

  final int chatId;
  final int threadRootId;
  final LaunchRequest launchRequest;
  final bool isNewThread;
  final bool implyLeadingInSplit;

  @override
  ConsumerState<ThreadDetailV2Page> createState() => _ThreadDetailV2PageState();
}

class _ThreadDetailV2PageState extends ConsumerState<ThreadDetailV2Page> {
  late bool _isNewThread = widget.isNewThread;

  Future<void> _handleMessageSent() async {
    if (!_isNewThread) {
      return;
    }
    // Backend auto-subscribes on the first thread reply; websocket
    // reconciliation owns refreshing active and archived thread lists.
    if (mounted) {
      setState(() {
        _isNewThread = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final isSplitLayout = ChatWorkspaceLayoutScope.isSplitLayout(context);
    final ConversationIdentity identity = (
      chatId: widget.chatId,
      threadRootId: widget.threadRootId,
    );
    return CupertinoPageScaffold(
      resizeToAvoidBottomInset: false,
      navigationBar: CupertinoNavigationBar(
        automaticallyImplyLeading: !isSplitLayout || widget.implyLeadingInSplit,
        middle: Text(_isNewThread ? l10n.newThread : l10n.thread),
        // TODO: Add the thread subscribe button here once the Flutter UI is ready.
      ),
      child: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_isNewThread) const _NewThreadInstruction(),
            Expanded(
              child: ConversationSurfaceV2(
                identity: identity,
                launchRequest: widget.launchRequest,
                onMessageSent: _handleMessageSent,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NewThreadInstruction extends StatelessWidget {
  const _NewThreadInstruction();

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;
    final l10n = AppLocalizations.of(context)!;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.backgroundSecondary,
        border: Border(
          bottom: BorderSide(
            color: CupertinoColors.separator.resolveFrom(context),
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
        child: Text(
          l10n.newThreadInstruction,
          textAlign: TextAlign.center,
          style: appMetaTextStyle(
            context,
            color: colors.textSecondary,
            height: 1.25,
          ),
        ),
      ),
    );
  }
}
