import 'package:chahua/features/conversation/shared/application/thread_detail_membership_view_model.dart';
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
    this.showBackButton = false,
  });

  final int chatId;
  final int threadRootId;
  final LaunchRequest launchRequest;
  final bool isNewThread;
  final bool implyLeadingInSplit;
  final bool showBackButton;

  @override
  ConsumerState<ThreadDetailV2Page> createState() => _ThreadDetailV2PageState();
}

class _ThreadDetailV2PageState extends ConsumerState<ThreadDetailV2Page> {
  late bool _isNewThread = widget.isNewThread;

  ThreadDetailMembershipIdentity get _membershipIdentity =>
      (chatId: widget.chatId, threadRootId: widget.threadRootId);

  Future<void> _handleMessageSent() async {
    if (!_isNewThread) {
      return;
    }
    // Backend auto-subscribes on the first thread reply; websocket
    // reconciliation owns refreshing active and archived thread lists.
    ref
        .read(
          threadDetailMembershipViewModelProvider(_membershipIdentity).notifier,
        )
        .markSubscribedFromReply();
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
        automaticallyImplyLeading:
            widget.showBackButton ||
            !isSplitLayout ||
            widget.implyLeadingInSplit,
        middle: Text(_isNewThread ? l10n.newThread : l10n.thread),
        trailing: _ThreadMembershipButton(identity: _membershipIdentity),
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

class _ThreadMembershipButton extends ConsumerWidget {
  const _ThreadMembershipButton({required this.identity});

  static const _buttonSize = 36.0;
  static const _iconSize = 26.0;

  final ThreadDetailMembershipIdentity identity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asyncState = ref.watch(
      threadDetailMembershipViewModelProvider(identity),
    );
    final l10n = AppLocalizations.of(context)!;

    return SizedBox(
      width: _buttonSize,
      height: _buttonSize,
      child: asyncState.maybeWhen(
        data: (state) => CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: state.isMutating
              ? null
              : () => _handlePressed(context, ref, state),
          child: state.isMutating
              ? const CupertinoActivityIndicator(radius: 9)
              : Semantics(
                  label: _semanticLabel(l10n, state),
                  button: true,
                  child: Icon(
                    state.membership == ThreadMembershipState.active
                        ? CupertinoIcons.bell_fill
                        : CupertinoIcons.bell_slash,
                    size: _iconSize,
                    color: state.membership == ThreadMembershipState.active
                        ? CupertinoColors.activeBlue.resolveFrom(context)
                        : CupertinoColors.secondaryLabel.resolveFrom(context),
                  ),
                ),
        ),
        loading: () =>
            const Center(child: CupertinoActivityIndicator(radius: 9)),
        orElse: () => CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: () =>
              ref.invalidate(threadDetailMembershipViewModelProvider(identity)),
          child: Icon(
            CupertinoIcons.bell_slash,
            size: _iconSize,
            color: CupertinoColors.secondaryLabel.resolveFrom(context),
          ),
        ),
      ),
    );
  }

  Future<void> _handlePressed(
    BuildContext context,
    WidgetRef ref,
    ThreadDetailMembershipViewState state,
  ) async {
    if (state.membership == ThreadMembershipState.archived) {
      final confirmed = await showCupertinoDialog<bool>(
        context: context,
        builder: (context) {
          final l10n = AppLocalizations.of(context)!;
          return CupertinoAlertDialog(
            title: Text(l10n.unarchiveThreadTitle),
            content: Text(l10n.unarchiveThreadMessage),
            actions: [
              CupertinoDialogAction(
                onPressed: () => Navigator.of(context).pop(false),
                child: Text(l10n.cancel),
              ),
              CupertinoDialogAction(
                onPressed: () => Navigator.of(context).pop(true),
                child: Text(l10n.ok),
              ),
            ],
          );
        },
      );
      if (confirmed != true) {
        return;
      }
    }

    await ref
        .read(threadDetailMembershipViewModelProvider(identity).notifier)
        .performBellAction();
  }

  String _semanticLabel(
    AppLocalizations l10n,
    ThreadDetailMembershipViewState state,
  ) {
    switch (state.membership) {
      case ThreadMembershipState.notSubscribed:
        return l10n.subscribeThreadAction;
      case ThreadMembershipState.active:
        return l10n.archiveThreadAction;
      case ThreadMembershipState.archived:
        return l10n.unarchiveThreadAction;
    }
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
