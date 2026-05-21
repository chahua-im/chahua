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
    this.secondaryIcon,
    this.secondaryLabel,
    this.secondaryOnAction,
    this.secondaryActionColor,
    this.secondaryDirection,
  });

  final Widget child;
  final IconData icon;
  final String label;
  final FutureOr<void> Function() onAction;
  final Color? actionColor;
  final SwipeToActionDirection direction;
  final IconData? secondaryIcon;
  final String? secondaryLabel;
  final FutureOr<void> Function()? secondaryOnAction;
  final Color? secondaryActionColor;
  final SwipeToActionDirection? secondaryDirection;

  @override
  Widget build(BuildContext context) {
    final primaryAction = _buildAction(
      icon: icon,
      label: label,
      onAction: onAction,
      color: actionColor ?? CupertinoColors.activeBlue,
    );
    final secondaryAction = switch ((
      secondaryIcon,
      secondaryLabel,
      secondaryOnAction,
    )) {
      (final icon?, final label?, final onAction?) => _buildAction(
        icon: icon,
        label: label,
        onAction: onAction,
        color: secondaryActionColor ?? CupertinoColors.activeBlue,
      ),
      _ => null,
    };
    final secondaryDirection =
        this.secondaryDirection ?? _oppositeDirection(direction);

    final leadingActions = [
      if (direction == SwipeToActionDirection.right) primaryAction,
      if (secondaryAction != null &&
          secondaryDirection == SwipeToActionDirection.right)
        secondaryAction,
    ];
    final trailingActions = [
      if (direction == SwipeToActionDirection.left) primaryAction,
      if (secondaryAction != null &&
          secondaryDirection == SwipeToActionDirection.left)
        secondaryAction,
    ];

    return SwipeActionCell(
      key: key!,
      backgroundColor: CupertinoColors.systemBackground.resolveFrom(context),
      fullSwipeFactor: 0.6,
      leadingActions: leadingActions.isEmpty ? null : leadingActions,
      trailingActions: trailingActions.isEmpty ? null : trailingActions,
      child: child,
    );
  }

  SwipeAction _buildAction({
    required IconData icon,
    required String label,
    required FutureOr<void> Function() onAction,
    required Color color,
  }) {
    return SwipeAction(
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
  }

  SwipeToActionDirection _oppositeDirection(SwipeToActionDirection direction) {
    return switch (direction) {
      SwipeToActionDirection.right => SwipeToActionDirection.left,
      SwipeToActionDirection.left => SwipeToActionDirection.right,
    };
  }
}
