import 'dart:async';

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_mention_autocomplete.dart';
import 'package:chahua/features/conversation/search/domain/message_search_sort.dart';
import 'package:chahua/features/conversation/search/domain/message_search_tag.dart';
import 'package:chahua/features/groups/members/data/group_member_models.dart';
import 'package:chahua/features/groups/members/data/group_member_repository.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class MessageSearchControls extends ConsumerStatefulWidget {
  const MessageSearchControls({
    super.key,
    required this.chatId,
    required this.controller,
    required this.sort,
    required this.inlineTagsEnabled,
    required this.onQueryChanged,
    required this.onQuerySubmitted,
    required this.onSortChanged,
  });

  final int chatId;
  final TextEditingController controller;
  final MessageSearchSort sort;
  final bool inlineTagsEnabled;
  final ValueChanged<String> onQueryChanged;
  final ValueChanged<String> onQuerySubmitted;
  final ValueChanged<MessageSearchSort> onSortChanged;

  @override
  ConsumerState<MessageSearchControls> createState() =>
      _MessageSearchControlsState();
}

class _MessageSearchControlsState extends ConsumerState<MessageSearchControls> {
  static const Duration _tagDebounce = Duration(milliseconds: 250);
  static const int _tagSuggestionLimit = 8;

  final FocusNode _searchFocusNode = FocusNode();
  Timer? _tagDebounceTimer;
  int _tagLookupVersion = 0;
  bool _tagLoading = false;
  MessageSearchTagTrigger? _activeTagTrigger;
  List<GroupMember> _tagResults = const <GroupMember>[];
  List<MessageSearchTag> _tags = const <MessageSearchTag>[];

  bool get _showTagSuggestions =>
      widget.inlineTagsEnabled && (_tagLoading || _tagResults.isNotEmpty);

  @override
  void initState() {
    super.initState();
    _searchFocusNode.addListener(_handleFocusChanged);
  }

  @override
  void didUpdateWidget(MessageSearchControls oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.inlineTagsEnabled && !widget.inlineTagsEnabled) {
      _clearTagSuggestions(clearTags: true);
    }
  }

  @override
  void dispose() {
    _tagDebounceTimer?.cancel();
    _searchFocusNode.removeListener(_handleFocusChanged);
    _searchFocusNode.dispose();
    super.dispose();
  }

  void _handleFocusChanged() {
    if (_searchFocusNode.hasFocus) {
      if (_activeTagTrigger == null) {
        _refreshTagSuggestions();
      }
      return;
    }
    setState(() => _clearTagSuggestions());
  }

  void _handleQueryChanged(String value) {
    widget.onQueryChanged(value);
    _refreshTagSuggestions();
  }

  void _refreshTagSuggestions() {
    if (!widget.inlineTagsEnabled) {
      return;
    }

    final selection = widget.controller.selection;
    if (!_searchFocusNode.hasFocus ||
        !selection.isValid ||
        !selection.isCollapsed) {
      setState(() => _clearTagSuggestions());
      return;
    }

    final trigger = detectMessageSearchTagTrigger(
      widget.controller.text,
      selection.extentOffset,
    );
    if (trigger == null) {
      setState(() => _clearTagSuggestions());
      return;
    }

    final current = _activeTagTrigger;
    if (current != null &&
        current.kind == trigger.kind &&
        current.query == trigger.query &&
        current.triggerStart == trigger.triggerStart) {
      return;
    }

    setState(() {
      _activeTagTrigger = trigger;
      _tagLoading = true;
      _tagResults = const <GroupMember>[];
    });
    _tagDebounceTimer?.cancel();
    _tagDebounceTimer = Timer(
      _tagDebounce,
      () => unawaited(_loadTagSuggestions(trigger)),
    );
  }

  Future<void> _loadTagSuggestions(MessageSearchTagTrigger trigger) async {
    final lookupVersion = ++_tagLookupVersion;
    try {
      final page = await ref
          .read(groupMemberRepositoryProvider)
          .fetchMembers(
            widget.chatId.toString(),
            limit: _tagSuggestionLimit,
            query: trigger.query,
            searchMode: GroupMemberSearchMode.autocomplete,
          );
      if (!mounted ||
          lookupVersion != _tagLookupVersion ||
          _activeTagTrigger?.query != trigger.query) {
        return;
      }
      setState(() {
        _tagResults = page.members;
        _tagLoading = false;
      });
    } catch (_) {
      if (!mounted ||
          lookupVersion != _tagLookupVersion ||
          _activeTagTrigger?.query != trigger.query) {
        return;
      }
      setState(() {
        _tagResults = const <GroupMember>[];
        _tagLoading = false;
      });
    }
  }

  void _openFromFilter() {
    final selection = widget.controller.selection;
    final cursor = selection.isValid && selection.isCollapsed
        ? selection.extentOffset
        : widget.controller.text.length;
    final trigger = MessageSearchTagTrigger(
      kind: MessageSearchTagKind.from,
      query: '',
      triggerStart: cursor,
    );

    _searchFocusNode.requestFocus();
    setState(() {
      _activeTagTrigger = trigger;
      _tagLoading = true;
      _tagResults = const <GroupMember>[];
    });
    _tagDebounceTimer?.cancel();
    unawaited(_loadTagSuggestions(trigger));
  }

  void _selectFromMember(GroupMember member) {
    final label = _displayName(member);
    final tag = MessageSearchTag.fromUser(uid: member.uid, label: label);
    final trigger = _activeTagTrigger;
    final selection = widget.controller.selection;
    if (trigger != null && selection.isValid && selection.isCollapsed) {
      _removeTriggerText(trigger.triggerStart, selection.extentOffset);
    }

    setState(() {
      _tags = [
        for (final existing in _tags)
          if (existing.kind != tag.kind) existing,
        tag,
      ];
      _clearTagSuggestions();
    });
    _searchFocusNode.requestFocus();
  }

  void _removeTriggerText(int triggerStart, int cursorPosition) {
    final text = widget.controller.text;
    if (triggerStart < 0 ||
        triggerStart > text.length ||
        cursorPosition < triggerStart ||
        cursorPosition > text.length) {
      return;
    }

    final before = text.substring(0, triggerStart).trimRight();
    final after = text.substring(cursorPosition).trimLeft();
    final nextText = switch ((before.isEmpty, after.isEmpty)) {
      (true, true) => '',
      (true, false) => after,
      (false, true) => before,
      (false, false) => '$before $after',
    };
    final cursor = before.isEmpty ? 0 : before.length;
    widget.controller.value = TextEditingValue(
      text: nextText,
      selection: TextSelection.collapsed(offset: cursor),
    );
    widget.onQueryChanged(nextText);
  }

  void _removeTag(MessageSearchTag tag) {
    setState(() {
      _tags = [
        for (final existing in _tags)
          if (existing != tag) existing,
      ];
    });
  }

  void _clearTagSuggestions({bool clearTags = false}) {
    _tagDebounceTimer?.cancel();
    _tagDebounceTimer = null;
    _tagLookupVersion += 1;
    _activeTagTrigger = null;
    _tagLoading = false;
    _tagResults = const <GroupMember>[];
    if (clearTags) {
      _tags = const <MessageSearchTag>[];
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: widget.inlineTagsEnabled
                  ? _InlineTagSearchField(
                      controller: widget.controller,
                      focusNode: _searchFocusNode,
                      tags: _tags,
                      placeholder: l10n.messageSearchPlaceholder,
                      onChanged: _handleQueryChanged,
                      onSubmitted: widget.onQuerySubmitted,
                      onRemoveTag: _removeTag,
                    )
                  : _PlainSearchField(
                      controller: widget.controller,
                      focusNode: _searchFocusNode,
                      placeholder: l10n.messageSearchPlaceholder,
                      onChanged: _handleQueryChanged,
                      onSubmitted: widget.onQuerySubmitted,
                    ),
            ),
            if (widget.inlineTagsEnabled) ...[
              const SizedBox(width: 8),
              _IconCircleButton(
                icon: CupertinoIcons.plus,
                label: l10n.messageSearchAddFilter,
                onPressed: _openFromFilter,
              ),
            ],
            const SizedBox(width: 8),
            _SortButton(sort: widget.sort, onChanged: widget.onSortChanged),
          ],
        ),
        if (_showTagSuggestions) ...[
          const SizedBox(height: 8),
          _TagSuggestionPanel(
            title: l10n.messageSearchFromFilter,
            results: _tagResults,
            loading: _tagLoading,
            onSelect: _selectFromMember,
          ),
        ],
      ],
    );
  }

  String _displayName(GroupMember member) {
    final username = member.username;
    if (username != null && username.trim().isNotEmpty) {
      return username.trim();
    }
    return 'User ${member.uid}';
  }
}

class _PlainSearchField extends StatelessWidget {
  const _PlainSearchField({
    required this.controller,
    required this.focusNode,
    required this.placeholder,
    required this.onChanged,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final String placeholder;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;

  @override
  Widget build(BuildContext context) {
    return CupertinoTextField(
      controller: controller,
      focusNode: focusNode,
      placeholder: placeholder,
      prefix: const Padding(
        padding: EdgeInsetsDirectional.only(start: 8),
        child: Icon(CupertinoIcons.search, size: 18),
      ),
      clearButtonMode: OverlayVisibilityMode.editing,
      textInputAction: TextInputAction.search,
      onChanged: onChanged,
      onSubmitted: onSubmitted,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
      decoration: BoxDecoration(
        color: CupertinoColors.systemFill.resolveFrom(context),
        borderRadius: BorderRadius.circular(10),
      ),
    );
  }
}

class _InlineTagSearchField extends StatelessWidget {
  const _InlineTagSearchField({
    required this.controller,
    required this.focusNode,
    required this.tags,
    required this.placeholder,
    required this.onChanged,
    required this.onSubmitted,
    required this.onRemoveTag,
  });

  final TextEditingController controller;
  final FocusNode focusNode;
  final List<MessageSearchTag> tags;
  final String placeholder;
  final ValueChanged<String> onChanged;
  final ValueChanged<String> onSubmitted;
  final ValueChanged<MessageSearchTag> onRemoveTag;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemFill.resolveFrom(context),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.only(start: 8),
        child: Row(
          children: [
            const Icon(CupertinoIcons.search, size: 18),
            const SizedBox(width: 6),
            for (final tag in tags) ...[
              _SearchTagChip(tag: tag, onRemove: () => onRemoveTag(tag)),
              const SizedBox(width: 6),
            ],
            Expanded(
              child: CupertinoTextField(
                controller: controller,
                focusNode: focusNode,
                placeholder: tags.isEmpty ? placeholder : null,
                clearButtonMode: OverlayVisibilityMode.editing,
                textInputAction: TextInputAction.search,
                onChanged: onChanged,
                onSubmitted: onSubmitted,
                padding: const EdgeInsets.symmetric(vertical: 9),
                decoration: null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchTagChip extends StatelessWidget {
  const _SearchTagChip({required this.tag, required this.onRemove});

  final MessageSearchTag tag;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemBackground.resolveFrom(context),
        border: Border.all(
          color: CupertinoColors.separator.resolveFrom(context),
        ),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.only(start: 7, top: 4, bottom: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(tag.displayLabel, style: appCaptionTextStyle(context)),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 5),
              minimumSize: Size.zero,
              onPressed: onRemove,
              child: Icon(
                CupertinoIcons.xmark,
                size: 11,
                color: CupertinoColors.secondaryLabel.resolveFrom(context),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SortButton extends StatelessWidget {
  const _SortButton({required this.sort, required this.onChanged});

  final MessageSearchSort sort;
  final ValueChanged<MessageSearchSort> onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final label = _sortLabel(l10n, sort);

    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      minimumSize: const Size(0, 38),
      borderRadius: BorderRadius.circular(19),
      color: CupertinoColors.systemBackground.resolveFrom(context),
      onPressed: () => _showSortPicker(context),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(CupertinoIcons.arrow_up_arrow_down, size: 17),
          const SizedBox(width: 5),
          Text(label, style: appCaptionTextStyle(context)),
        ],
      ),
    );
  }

  Future<void> _showSortPicker(BuildContext context) async {
    final l10n = AppLocalizations.of(context)!;
    final selected = await showCupertinoModalPopup<MessageSearchSort>(
      context: context,
      builder: (context) {
        return CupertinoActionSheet(
          title: Text(l10n.messageSearchSortPickerTitle),
          actions: [
            _SortAction(
              sort: MessageSearchSort.best,
              selectedSort: sort,
              label: l10n.messageSearchSortBest,
            ),
            _SortAction(
              sort: MessageSearchSort.recent,
              selectedSort: sort,
              label: l10n.messageSearchSortRecent,
            ),
          ],
          cancelButton: CupertinoActionSheetAction(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.cancel),
          ),
        );
      },
    );
    if (selected != null && selected != sort) {
      onChanged(selected);
    }
  }

  String _sortLabel(AppLocalizations l10n, MessageSearchSort sort) {
    return switch (sort) {
      MessageSearchSort.best => l10n.messageSearchSortBest,
      MessageSearchSort.recent => l10n.messageSearchSortRecent,
    };
  }
}

class _SortAction extends StatelessWidget {
  const _SortAction({
    required this.sort,
    required this.selectedSort,
    required this.label,
  });

  final MessageSearchSort sort;
  final MessageSearchSort selectedSort;
  final String label;

  @override
  Widget build(BuildContext context) {
    return CupertinoActionSheetAction(
      onPressed: () => Navigator.of(context).pop(sort),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(label),
          if (sort == selectedSort) ...[
            const SizedBox(width: 8),
            const Icon(CupertinoIcons.check_mark, size: 17),
          ],
        ],
      ),
    );
  }
}

class _IconCircleButton extends StatelessWidget {
  const _IconCircleButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: CupertinoButton(
        padding: EdgeInsets.zero,
        minimumSize: const Size(38, 38),
        borderRadius: BorderRadius.circular(19),
        color: CupertinoColors.systemBackground.resolveFrom(context),
        onPressed: onPressed,
        child: Icon(icon, size: 18),
      ),
    );
  }
}

class _TagSuggestionPanel extends StatelessWidget {
  const _TagSuggestionPanel({
    required this.title,
    required this.results,
    required this.loading,
    required this.onSelect,
  });

  final String title;
  final List<GroupMember> results;
  final bool loading;
  final ValueChanged<GroupMember> onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;

    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: DecoratedBox(
        decoration: BoxDecoration(color: colors.backgroundSecondary),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
              child: Text(
                title,
                style: appCaptionTextStyle(
                  context,
                  fontWeight: AppFontWeights.semibold,
                ),
              ),
            ),
            ComposerMentionAutocomplete(
              results: results,
              loading: loading,
              onSelect: onSelect,
            ),
          ],
        ),
      ),
    );
  }
}
