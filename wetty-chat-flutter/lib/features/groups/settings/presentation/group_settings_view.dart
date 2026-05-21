import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../../app/routing/route_names.dart';
import '../../../../app/theme/style_config.dart';
import '../../../../core/session/dev_session_store.dart';
import '../../../chat_list/application/group_list_v2_store.dart';
import '../../members/data/group_member_repository.dart';
import '../../../shared/presentation/app_avatar.dart';
import '../../members/presentation/widgets/group_member_actions.dart';
import '../../metadata/application/group_metadata_view_model.dart';
import '../../metadata/data/group_metadata_models.dart';
import 'package:chahua/l10n/app_localizations.dart';

/// Group Settings page: hero section, mute/leave actions, edit group name,
/// description, and save.
class GroupSettingsPage extends ConsumerStatefulWidget {
  const GroupSettingsPage({super.key, required this.chatId});

  final String chatId;

  @override
  ConsumerState<GroupSettingsPage> createState() => _GroupSettingsPageState();
}

class _GroupSettingsPageState extends ConsumerState<GroupSettingsPage> {
  bool _isLeavingGroup = false;

  TextStyle _placeholderStyle(BuildContext context) {
    return appBodyTextStyle(
      context,
      color: CupertinoColors.placeholderText.resolveFrom(context),
    );
  }

  void _showErrorDialog(String message) {
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: const Text('Error'),
        content: Text(message),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _showToast(String message) {
    final overlay = Navigator.of(context).overlay;
    if (overlay == null) {
      return;
    }

    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (_) => Positioned(
        left: 24,
        right: 24,
        bottom: 80,
        child: _ToastWidget(message: message, onDismiss: () => entry.remove()),
      ),
    );
    overlay.insert(entry);
  }

  void _showMuteActionSheet() {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (context) => CupertinoActionSheet(
        title: const Text('Mute notifications'),
        actions: [
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(context);
              _muteChat(durationSeconds: 3600);
            },
            child: const Text('1 hour'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(context);
              _muteChat(durationSeconds: 28800);
            },
            child: const Text('8 hours'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(context);
              _muteChat(durationSeconds: 86400);
            },
            child: const Text('1 day'),
          ),
          CupertinoActionSheetAction(
            onPressed: () {
              Navigator.pop(context);
              _muteChat(durationSeconds: 604800);
            },
            child: const Text('7 days'),
          ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () {
              Navigator.pop(context);
              _muteChat();
            },
            child: const Text('Forever'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
      ),
    );
  }

  Future<void> _muteChat({int? durationSeconds}) async {
    try {
      await ref
          .read(groupMetadataViewModelProvider(widget.chatId).notifier)
          .muteChat(durationSeconds: durationSeconds);
      if (!mounted) return;
      _showToast('Notifications muted');
    } catch (error) {
      if (!mounted) return;
      _showErrorDialog('$error');
    }
  }

  Future<void> _unmuteChat() async {
    try {
      await ref
          .read(groupMetadataViewModelProvider(widget.chatId).notifier)
          .unmuteChat();
      if (!mounted) return;
      _showToast('Notifications unmuted');
    } catch (error) {
      if (!mounted) return;
      _showErrorDialog('$error');
    }
  }

  Future<void> _leaveGroup() async {
    final confirmed = await GroupMemberActions.confirmAction(
      context,
      title: 'Leave Group',
      message: 'Are you sure you want to leave this group?',
      confirmLabel: 'Leave',
      isDestructive: true,
    );
    if (!confirmed || !mounted) return;

    setState(() {
      _isLeavingGroup = true;
    });

    try {
      final currentUserId = ref.read(authSessionProvider).currentUserId;
      await ref
          .read(groupMemberRepositoryProvider)
          .removeMember(widget.chatId, userId: currentUserId);
      if (!mounted) return;
      ref.read(groupListV2StoreProvider.notifier).removeGroup(widget.chatId);
      context.go(AppRoutes.chats);
    } catch (error) {
      if (!mounted) return;
      _showErrorDialog('$error');
    } finally {
      if (mounted) {
        setState(() {
          _isLeavingGroup = false;
        });
      }
    }
  }

  String _formatMutedLabel(DateTime mutedUntil) {
    if (mutedUntil.year >= 9000) {
      return 'Muted indefinitely';
    }
    final difference = mutedUntil.difference(DateTime.now());
    if (difference.inHours < 24) {
      return 'Muted until ${DateFormat.jm().format(mutedUntil)}';
    }
    return 'Muted until ${DateFormat.MMMd().format(mutedUntil)}';
  }

  Widget _buildHeroSection(BuildContext context, ChatMetadata metadata) {
    return Column(
      children: [
        AppAvatar(
          name: metadata.displayName,
          imageUrl: metadata.avatarUrl,
          size: 80,
          memCacheWidth: 160,
          fallbackTextStyle: appOnDarkTextStyle(
            context,
            fontSize: 32,
            fontWeight: AppFontWeights.semibold,
          ),
        ),
        const SizedBox(height: 12),
        Text(
          metadata.displayName,
          style: appTitleTextStyle(context, fontWeight: AppFontWeights.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 4),
        if (metadata.description != null &&
            metadata.description!.trim().isNotEmpty)
          Text(
            metadata.description!,
            style: appSecondaryTextStyle(context),
            textAlign: TextAlign.center,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          )
        else
          Text(
            'No group description yet.',
            style: _placeholderStyle(context),
            textAlign: TextAlign.center,
          ),
      ],
    );
  }

  Widget _buildActionButtons(BuildContext context, ChatMetadata metadata) {
    final isMuted =
        metadata.mutedUntil != null &&
        metadata.mutedUntil!.isAfter(DateTime.now());

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _buildActionButton(
          context,
          icon: CupertinoIcons.search,
          label: AppLocalizations.of(context)!.messageSearchAction,
          onTap: () => context.push(AppRoutes.chatMessageSearch(widget.chatId)),
        ),
        const SizedBox(width: 12),
        _buildActionButton(
          context,
          icon: isMuted ? CupertinoIcons.bell_slash_fill : CupertinoIcons.bell,
          label: isMuted ? _formatMutedLabel(metadata.mutedUntil!) : 'Mute',
          onTap: isMuted ? _unmuteChat : _showMuteActionSheet,
        ),
        const SizedBox(width: 12),
        _buildActionButton(
          context,
          icon: CupertinoIcons.square_arrow_right,
          label: 'Leave',
          color: CupertinoColors.destructiveRed,
          onTap: _isLeavingGroup ? null : _leaveGroup,
        ),
      ],
    );
  }

  Widget _buildActionButton(
    BuildContext context, {
    required IconData icon,
    required String label,
    Color? color,
    VoidCallback? onTap,
  }) {
    final resolvedColor = color ?? CupertinoColors.label.resolveFrom(context);

    return GestureDetector(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minWidth: 90),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        decoration: BoxDecoration(
          color: CupertinoColors.systemGrey6.resolveFrom(context),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 28, color: resolvedColor),
            const SizedBox(height: 4),
            Text(
              label,
              style: appCaptionTextStyle(context, color: resolvedColor),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final metadataAsync = ref.watch(
      groupMetadataViewModelProvider(widget.chatId),
    );

    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(AppLocalizations.of(context)!.groupSettings),
      ),
      child: GestureDetector(
        onTap: () => FocusScope.of(context).unfocus(),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
            child: metadataAsync.when(
              loading: () => const Center(child: CupertinoActivityIndicator()),
              error: (error, _) => Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text('$error', textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    CupertinoButton.filled(
                      onPressed: () => ref
                          .read(
                            groupMetadataViewModelProvider(
                              widget.chatId,
                            ).notifier,
                          )
                          .reload(),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (data) => SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _buildHeroSection(context, data),
                    const SizedBox(height: 20),
                    _buildActionButtons(context, data),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ToastWidget extends StatefulWidget {
  const _ToastWidget({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  State<_ToastWidget> createState() => _ToastWidgetState();
}

class _ToastWidgetState extends State<_ToastWidget> {
  Timer? _dismissTimer;

  @override
  void initState() {
    super.initState();
    _dismissTimer = Timer(const Duration(seconds: 2), widget.onDismiss);
  }

  @override
  void dispose() {
    _dismissTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemGrey.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Text(
          widget.message,
          textAlign: TextAlign.center,
          style: appBodyTextStyle(context, color: CupertinoColors.white),
        ),
      ),
    );
  }
}
