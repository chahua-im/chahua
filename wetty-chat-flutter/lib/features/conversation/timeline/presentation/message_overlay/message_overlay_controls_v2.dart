import 'package:chahua/app/theme/style_config.dart';
import 'package:flutter/cupertino.dart';

import 'message_overlay_action_v2.dart';
import 'message_overlay_metrics_v2.dart';

class MessageOverlayActionPanelV2 extends StatefulWidget {
  const MessageOverlayActionPanelV2({super.key, required this.actions});

  final List<MessageOverlayActionV2> actions;

  @override
  State<MessageOverlayActionPanelV2> createState() =>
      _MessageOverlayActionPanelV2State();
}

class _MessageOverlayActionPanelV2State
    extends State<MessageOverlayActionPanelV2> {
  static const _columns = MessageOverlayMetricsV2.actionColumns;
  static const _visibleSlots = MessageOverlayMetricsV2.actionVisibleSlots;

  int _page = 0;

  bool get _needsPagination => widget.actions.length > _visibleSlots;

  int get _lastPage {
    if (!_needsPagination) {
      return 0;
    }
    final remainingActions = widget.actions.length - (_visibleSlots - 1);
    return ((remainingActions - 1) ~/ (_visibleSlots - 2)) + 1;
  }

  @override
  void didUpdateWidget(covariant MessageOverlayActionPanelV2 oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.actions.length != widget.actions.length ||
        !_sameActionLabels(oldWidget.actions, widget.actions)) {
      _page = 0;
    } else if (_page > _lastPage) {
      _page = _lastPage;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;
    final rows = _actionRows();
    return Container(
      width: MessageOverlayMetricsV2.panelMaxWidth,
      decoration: BoxDecoration(
        color: colors.backgroundSecondary,
        borderRadius: BorderRadius.circular(14),
        boxShadow: const [
          BoxShadow(
            blurRadius: 22,
            offset: Offset(0, 8),
            color: Color(0x22000000),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (index, row) in rows.indexed) ...[
              _ActionRow(items: row, onPageChanged: _setPage),
              if (index < rows.length - 1)
                Container(
                  height: 1,
                  color: CupertinoColors.separator.resolveFrom(context),
                ),
            ],
          ],
        ),
      ),
    );
  }

  void _setPage(int page) {
    setState(() {
      _page = page.clamp(0, _lastPage);
    });
  }

  List<List<_ActionPanelItem>> _actionRows() {
    final items = _visibleItems();
    return [
      for (var start = 0; start < items.length; start += _columns)
        items.sublist(start, (start + _columns).clamp(0, items.length)),
    ];
  }

  List<_ActionPanelItem> _visibleItems() {
    if (!_needsPagination) {
      return [
        for (final action in widget.actions) _ActionPanelItem.action(action),
      ];
    }

    final page = _page.clamp(0, _lastPage);
    if (page == 0) {
      return [
        for (final action in widget.actions.take(_visibleSlots - 1))
          _ActionPanelItem.action(action),
        const _ActionPanelItem.pageDown(1),
      ];
    }

    final start = (_visibleSlots - 1) + ((page - 1) * (_visibleSlots - 2));
    final end = start + (_visibleSlots - (page < _lastPage ? 2 : 1));
    return [
      _ActionPanelItem.pageUp(page - 1),
      for (final action in widget.actions.getRange(
        start,
        end.clamp(start, widget.actions.length),
      ))
        _ActionPanelItem.action(action),
      if (page < _lastPage) _ActionPanelItem.pageDown(page + 1),
    ];
  }

  bool _sameActionLabels(
    List<MessageOverlayActionV2> previous,
    List<MessageOverlayActionV2> next,
  ) {
    if (previous.length != next.length) {
      return false;
    }
    for (var index = 0; index < previous.length; index++) {
      if (previous[index].label != next[index].label) {
        return false;
      }
    }
    return true;
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.items, required this.onPageChanged});

  final List<_ActionPanelItem> items;
  final ValueChanged<int> onPageChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: MessageOverlayMetricsV2.actionRowHeight,
      child: Row(
        children: [
          for (final item in items)
            Expanded(
              child: switch (item) {
                _ActionButtonItem(:final action) => _ActionButton(
                  action: action,
                ),
                _PageDownItem() => _PageButton(
                  icon: CupertinoIcons.chevron_down,
                  onPressed: () => onPageChanged(item.page),
                ),
                _PageUpItem() => _PageButton(
                  icon: CupertinoIcons.chevron_up,
                  onPressed: () => onPageChanged(item.page),
                ),
              },
            ),
          for (
            var index = items.length;
            index < MessageOverlayMetricsV2.actionColumns;
            index++
          )
            const Spacer(),
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({required this.action});

  final MessageOverlayActionV2 action;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
      minimumSize: Size.zero,
      borderRadius: BorderRadius.zero,
      onPressed: action.onPressed,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (action.icon case final icon?) ...[
            Icon(icon, size: 22, color: context.appColors.textPrimary),
            const SizedBox(height: 4),
          ],
          Text(
            action.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: appCaptionTextStyle(
              context,
              fontWeight: AppFontWeights.medium,
            ),
          ),
        ],
      ),
    );
  }
}

class _PageButton extends StatelessWidget {
  const _PageButton({required this.icon, required this.onPressed});

  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return CupertinoButton(
      padding: EdgeInsets.zero,
      minimumSize: Size.zero,
      borderRadius: BorderRadius.zero,
      onPressed: onPressed,
      child: Center(
        child: Icon(icon, size: 22, color: context.appColors.textPrimary),
      ),
    );
  }
}

sealed class _ActionPanelItem {
  const _ActionPanelItem();

  const factory _ActionPanelItem.action(MessageOverlayActionV2 action) =
      _ActionButtonItem;

  const factory _ActionPanelItem.pageDown([int page]) = _PageDownItem;

  const factory _ActionPanelItem.pageUp([int page]) = _PageUpItem;
}

class _ActionButtonItem extends _ActionPanelItem {
  const _ActionButtonItem(this.action);

  final MessageOverlayActionV2 action;
}

class _PageDownItem extends _ActionPanelItem {
  const _PageDownItem([this.page = 1]);

  final int page;
}

class _PageUpItem extends _ActionPanelItem {
  const _PageUpItem([this.page = 0]);

  final int page;
}
