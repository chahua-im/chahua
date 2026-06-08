import 'dart:async';

import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/api/models/saved_messages_api_models.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/saved_messages/application/saved_messages_view_model.dart';
import 'package:chahua/features/saved_messages/domain/saved_message_preview.dart';
import 'package:chahua/features/saved_messages/domain/saved_message_target.dart';
import 'package:chahua/features/saved_messages/domain/saved_messages_scope.dart';
import 'package:chahua/features/shared/presentation/app_avatar.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

class SavedMessagesPage extends ConsumerStatefulWidget {
  const SavedMessagesPage({super.key, this.chatId});

  final int? chatId;

  @override
  ConsumerState<SavedMessagesPage> createState() => _SavedMessagesPageState();
}

class _SavedMessagesPageState extends ConsumerState<SavedMessagesPage> {
  SavedMessagesScope get _scope {
    final chatId = widget.chatId;
    return chatId == null
        ? const SavedMessagesScope.global()
        : SavedMessagesScope.chat(chatId);
  }

  void _openSavedMessage(SavedMessageResponseDto saved) {
    if (!saved.canLocateContext) {
      return;
    }

    final target = SavedMessageTarget.fromSavedMessage(saved);
    final launchRequest = LaunchRequest.message(messageId: target.messageId);
    final threadRootId = target.threadRootId;
    if (threadRootId == null) {
      context.push(
        AppRoutes.savedMessageChatDetail('${target.chatId}'),
        extra: <String, dynamic>{
          AppRouteExtraKeys.launchRequest: launchRequest,
        },
      );
      return;
    }
    context.push(
      AppRoutes.savedMessageThreadDetail('${target.chatId}', '$threadRootId'),
      extra: <String, dynamic>{AppRouteExtraKeys.launchRequest: launchRequest},
    );
  }

  Future<void> _confirmUnsave(SavedMessageResponseDto saved) async {
    final l10n = AppLocalizations.of(context)!;
    final confirmed = await showCupertinoDialog<bool>(
      context: context,
      builder: (context) {
        return CupertinoAlertDialog(
          title: Text(l10n.savedMessageUnsaveTitle),
          content: Text(l10n.savedMessageUnsaveBody),
          actions: [
            CupertinoDialogAction(
              onPressed: () => Navigator.pop(context, false),
              child: Text(l10n.cancel),
            ),
            CupertinoDialogAction(
              isDestructiveAction: true,
              onPressed: () => Navigator.pop(context, true),
              child: Text(l10n.savedMessageUnsave),
            ),
          ],
        );
      },
    );

    if (confirmed != true || !mounted) {
      return;
    }

    try {
      await ref
          .read(savedMessagesViewModelProvider(_scope).notifier)
          .unsave(saved.id);
    } catch (_) {
      if (!mounted) {
        return;
      }
      _showToast(l10n.savedMessageUnsaveFailed);
    }
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
        child: _SavedMessagesToast(
          message: message,
          onDismiss: () => entry.remove(),
        ),
      ),
    );
    overlay.insert(entry);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(savedMessagesViewModelProvider(_scope));

    return CupertinoPageScaffold(
      backgroundColor: CupertinoColors.systemGroupedBackground,
      navigationBar: CupertinoNavigationBar(
        middle: Text(l10n.savedMessagesTitle),
      ),
      child: SafeArea(
        child: state.when(
          loading: () => const Center(child: CupertinoActivityIndicator()),
          error: (_, _) => _SavedMessagesStateView(
            text: l10n.savedMessagesLoadFailed,
            actionLabel: l10n.retry,
            onAction: () => ref
                .read(savedMessagesViewModelProvider(_scope).notifier)
                .reload(),
          ),
          data: (data) => _SavedMessagesList(
            state: data,
            scope: _scope,
            onOpen: _openSavedMessage,
            onUnsave: (saved) => unawaited(_confirmUnsave(saved)),
            onLoadMore: () => ref
                .read(savedMessagesViewModelProvider(_scope).notifier)
                .loadMore(),
          ),
        ),
      ),
    );
  }
}

class _SavedMessagesList extends StatelessWidget {
  const _SavedMessagesList({
    required this.state,
    required this.scope,
    required this.onOpen,
    required this.onUnsave,
    required this.onLoadMore,
  });

  final SavedMessagesState state;
  final SavedMessagesScope scope;
  final ValueChanged<SavedMessageResponseDto> onOpen;
  final ValueChanged<SavedMessageResponseDto> onUnsave;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    if (state.savedMessages.isEmpty) {
      return _SavedMessagesStateView(text: l10n.savedMessagesEmpty);
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      itemCount: state.savedMessages.length + (state.hasMore ? 1 : 0),
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        if (index >= state.savedMessages.length) {
          return CupertinoButton(
            onPressed: state.isLoadingMore ? null : onLoadMore,
            child: state.isLoadingMore
                ? const CupertinoActivityIndicator()
                : Text(l10n.savedMessagesLoadMore),
          );
        }

        final saved = state.savedMessages[index];
        return _SavedMessageCard(
          saved: saved,
          showChatName: scope.isGlobal,
          isUnsaving: state.unsavingIds.contains(saved.id),
          onOpen: () => onOpen(saved),
          onUnsave: () => onUnsave(saved),
        );
      },
    );
  }
}

class _SavedMessageCard extends StatelessWidget {
  const _SavedMessageCard({
    required this.saved,
    required this.showChatName,
    required this.isUnsaving,
    required this.onOpen,
    required this.onUnsave,
  });

  final SavedMessageResponseDto saved;
  final bool showChatName;
  final bool isUnsaving;
  final VoidCallback onOpen;
  final VoidCallback onUnsave;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final senderName = _senderName(l10n, saved);
    final chatName = _chatName(l10n, saved);
    final preview = formatSavedMessagePreview(saved, l10n);
    final originalTimestamp = _formatMessageTimestamp(
      context,
      saved.originalCreatedAt,
    );
    final savedDate = _formatSavedDate(context, saved.savedAt);
    final attachmentSummary = saved.attachments.isEmpty
        ? null
        : l10n.savedMessageAttachmentCount(saved.attachments.length);

    final canOpen = saved.canLocateContext;

    return Semantics(
      button: canOpen,
      enabled: canOpen,
      onTap: canOpen ? onOpen : null,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: canOpen ? onOpen : null,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: CupertinoColors.systemBackground.resolveFrom(context),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppAvatar(
                      name: senderName,
                      imageUrl: saved.sender.avatarUrl,
                      size: 40,
                      memCacheWidth: 80,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  senderName,
                                  style: appBodyTextStyle(
                                    context,
                                    fontWeight: AppFontWeights.semibold,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                originalTimestamp,
                                style: appCaptionTextStyle(context),
                              ),
                            ],
                          ),
                          if (showChatName) ...[
                            const SizedBox(height: 2),
                            Text(
                              chatName,
                              style: appCaptionTextStyle(
                                context,
                                color: CupertinoColors.systemBlue.resolveFrom(
                                  context,
                                ),
                                fontWeight: AppFontWeights.medium,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  preview.isEmpty ? l10n.message : preview,
                  style: appSecondaryTextStyle(context),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (attachmentSummary != null) ...[
                  const SizedBox(height: 6),
                  Text(attachmentSummary, style: appCaptionTextStyle(context)),
                ],
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        l10n.savedMessageSavedOn(savedDate),
                        style: appCaptionTextStyle(context),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Semantics(
                      button: true,
                      label: l10n.savedMessageUnsave,
                      child: CupertinoButton(
                        padding: EdgeInsets.zero,
                        minimumSize: const Size(32, 32),
                        onPressed: isUnsaving ? null : onUnsave,
                        child: isUnsaving
                            ? const CupertinoActivityIndicator(radius: 9)
                            : Icon(
                                CupertinoIcons.bookmark_fill,
                                size: 22,
                                color: CupertinoColors.activeBlue.resolveFrom(
                                  context,
                                ),
                              ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _senderName(AppLocalizations l10n, SavedMessageResponseDto saved) {
    final name = saved.sender.name?.trim();
    if (name != null && name.isNotEmpty) {
      return name;
    }
    return l10n.userFallbackName(saved.originalSenderUid);
  }

  String _chatName(AppLocalizations l10n, SavedMessageResponseDto saved) {
    final name = saved.chat.name?.trim();
    if (name != null && name.isNotEmpty) {
      return name;
    }
    return l10n.chatFallbackName('${saved.originalChatId}');
  }

  String _formatMessageTimestamp(BuildContext context, DateTime date) {
    final locale = Localizations.localeOf(context).toLanguageTag();
    final now = DateTime.now();
    if (date.year == now.year &&
        date.month == now.month &&
        date.day == now.day) {
      return DateFormat.jm(locale).format(date);
    }
    if (date.year == now.year) {
      return DateFormat.MMMd(locale).format(date);
    }
    return DateFormat.yMMMd(locale).format(date);
  }

  String _formatSavedDate(BuildContext context, DateTime date) {
    final locale = Localizations.localeOf(context).toLanguageTag();
    return DateFormat.yMMMd(locale).format(date);
  }
}

class _SavedMessagesStateView extends StatelessWidget {
  const _SavedMessagesStateView({
    required this.text,
    this.actionLabel,
    this.onAction,
  });

  final String text;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text,
              style: appSecondaryTextStyle(context),
              textAlign: TextAlign.center,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 12),
              CupertinoButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}

class _SavedMessagesToast extends StatefulWidget {
  const _SavedMessagesToast({required this.message, required this.onDismiss});

  final String message;
  final VoidCallback onDismiss;

  @override
  State<_SavedMessagesToast> createState() => _SavedMessagesToastState();
}

class _SavedMessagesToastState extends State<_SavedMessagesToast> {
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
