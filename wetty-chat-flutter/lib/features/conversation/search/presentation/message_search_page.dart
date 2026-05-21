import 'dart:async';

import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/features/conversation/search/application/message_search_view_model.dart';
import 'package:chahua/features/conversation/search/domain/message_search_state.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/shared/presentation/app_avatar.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

class MessageSearchPage extends ConsumerStatefulWidget {
  const MessageSearchPage({super.key, required this.chatId});

  final int chatId;

  @override
  ConsumerState<MessageSearchPage> createState() => _MessageSearchPageState();
}

class _MessageSearchPageState extends ConsumerState<MessageSearchPage> {
  static const Duration _searchDebounce = Duration(milliseconds: 300);

  final TextEditingController _searchController = TextEditingController();
  Timer? _searchDebounceTimer;

  @override
  void dispose() {
    _searchDebounceTimer?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _onSearchChanged(String value) {
    _searchDebounceTimer?.cancel();
    _searchDebounceTimer = Timer(_searchDebounce, () {
      ref
          .read(messageSearchViewModelProvider(widget.chatId).notifier)
          .updateQuery(value);
    });
  }

  Future<void> _submitSearch(String value) async {
    _searchDebounceTimer?.cancel();
    await ref
        .read(messageSearchViewModelProvider(widget.chatId).notifier)
        .updateQuery(value);
  }

  void _openResult(MessageSearchResult result) {
    final launchRequest = LaunchRequest.message(
      messageId: result.target.messageId,
    );
    final threadRootId = result.target.threadRootId;
    if (threadRootId == null) {
      context.go(
        AppRoutes.chatDetail(widget.chatId.toString()),
        extra: <String, dynamic>{'launchRequest': launchRequest},
      );
      return;
    }
    context.go(
      AppRoutes.nestedThreadDetail(widget.chatId.toString(), '$threadRootId'),
      extra: <String, dynamic>{'launchRequest': launchRequest},
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final state = ref.watch(messageSearchViewModelProvider(widget.chatId));

    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: Text(l10n.messageSearchTitle),
      ),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: CupertinoSearchTextField(
                controller: _searchController,
                placeholder: l10n.messageSearchPlaceholder,
                onChanged: _onSearchChanged,
                onSubmitted: _submitSearch,
              ),
            ),
            Expanded(
              child: state.when(
                loading: () =>
                    const Center(child: CupertinoActivityIndicator()),
                error: (_, _) =>
                    _MessageSearchStateText(text: l10n.messageSearchFailed),
                data: (data) => _MessageSearchResults(
                  state: data,
                  onOpenResult: _openResult,
                  onLoadMore: () => ref
                      .read(
                        messageSearchViewModelProvider(widget.chatId).notifier,
                      )
                      .loadMore(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageSearchResults extends StatelessWidget {
  const _MessageSearchResults({
    required this.state,
    required this.onOpenResult,
    required this.onLoadMore,
  });

  final MessageSearchState state;
  final ValueChanged<MessageSearchResult> onOpenResult;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    if (state.status == MessageSearchStatus.searching) {
      return const Center(child: CupertinoActivityIndicator());
    }

    if (state.status == MessageSearchStatus.idle) {
      return _MessageSearchStateText(
        text: state.query.isEmpty
            ? l10n.messageSearchEmptyPrompt
            : l10n.messageSearchMinChars,
      );
    }

    if (state.results.isEmpty) {
      return _MessageSearchStateText(text: l10n.messageSearchNoResults);
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      itemCount: state.results.length + (state.hasMore ? 1 : 0),
      separatorBuilder: (_, _) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        if (index >= state.results.length) {
          return CupertinoButton(
            onPressed: state.isLoadingMore ? null : onLoadMore,
            child: state.isLoadingMore
                ? const CupertinoActivityIndicator()
                : Text(l10n.messageSearchLoadMore),
          );
        }

        final result = state.results[index];
        return _MessageSearchResultRow(
          result: result,
          onTap: () => onOpenResult(result),
        );
      },
    );
  }
}

class _MessageSearchResultRow extends StatelessWidget {
  const _MessageSearchResultRow({required this.result, required this.onTap});

  final MessageSearchResult result;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final message = result.message;
    final senderName = message.sender.name?.trim();
    final resolvedName = senderName == null || senderName.isEmpty
        ? l10n.unknownUser
        : senderName;
    final preview = formatMessagePreviewSummary(
      _previewFromMessage(message),
      l10n: l10n,
    );
    final timestamp = _formatTimestamp(context, message.createdAt);

    return CupertinoButton(
      padding: EdgeInsets.zero,
      onPressed: onTap,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: CupertinoColors.systemBackground.resolveFrom(context),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              AppAvatar(
                name: resolvedName,
                imageUrl: message.sender.avatarUrl,
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
                            resolvedName,
                            style: appBodyTextStyle(
                              context,
                              fontWeight: AppFontWeights.semibold,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (timestamp.isNotEmpty) ...[
                          const SizedBox(width: 8),
                          Text(timestamp, style: appCaptionTextStyle(context)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      preview.isEmpty ? l10n.message : preview,
                      style: appSecondaryTextStyle(context),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (result.target.threadRootId != null) ...[
                      const SizedBox(height: 6),
                      Text(
                        l10n.messageSearchThreadContext,
                        style: appCaptionTextStyle(
                          context,
                          color: CupertinoColors.systemBlue.resolveFrom(
                            context,
                          ),
                          fontWeight: AppFontWeights.medium,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  MessagePreview _previewFromMessage(MessageItemDto message) {
    return MessagePreview(
      messageId: message.id,
      clientGeneratedId: message.clientGeneratedId.isEmpty
          ? null
          : message.clientGeneratedId,
      sender: User.fromDto(message.sender),
      message: message.message,
      messageType: message.messageType,
      sticker: message.sticker == null
          ? null
          : StickerSummary.fromDto(message.sticker!),
      createdAt: message.createdAt,
      attachments: message.attachments.map(AttachmentItem.fromDto).toList(),
      reactions: message.reactions.map(ReactionSummary.fromDto).toList(),
      firstAttachmentKind: message.attachments.isNotEmpty
          ? message.attachments.first.kind
          : null,
      isDeleted: message.isDeleted,
      mentions: message.mentions.map(MentionInfo.fromDto).toList(),
    );
  }

  String _formatTimestamp(BuildContext context, DateTime? date) {
    if (date == null) {
      return '';
    }

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
}

class _MessageSearchStateText extends StatelessWidget {
  const _MessageSearchStateText({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          text,
          style: appSecondaryTextStyle(context),
          textAlign: TextAlign.center,
        ),
      ),
    );
  }
}
