import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_swipe_action_cell/flutter_swipe_action_cell.dart';

enum SwipeToActionDirection { right, left }

/// iOS-style swipe-to-action row for chat list items.
/// Partial swipe reveals the action button; full swipe triggers it automatically.
class SwipeToActionRow extends StatelessWidget {
  const SwipeToActionRow({
    super.key,
    required this.child,
    required this.icon,
    required this.label,
    required this.onAction,
    this.actionColor,
    this.direction = SwipeToActionDirection.right,
  });

  final Widget child;
  final IconData icon;
  final String label;
  final FutureOr<void> Function() onAction;
  final Color? actionColor;
  final SwipeToActionDirection direction;

  @override
  Widget build(BuildContext context) {
    final color = actionColor ?? CupertinoColors.activeBlue;
    final action = SwipeAction(
      performsFirstActionWithFullSwipe: true,
      onTap: (handler) async {
        // Close the swipe cell before the action can remove this row.
        await handler(false);
        await onAction();
      },
      color: color,
      icon: Icon(icon, color: CupertinoColors.white),
      title: label,
      style: const TextStyle(color: CupertinoColors.white, fontSize: 12),
    );

    return SwipeActionCell(
      key: key!,
      backgroundColor: CupertinoColors.systemBackground.resolveFrom(context),
      fullSwipeFactor: 0.6,
      leadingActions: direction == SwipeToActionDirection.right
          ? [action]
          : null,
      trailingActions: direction == SwipeToActionDirection.left
          ? [action]
          : null,
      child: child,
    );
  }
}
