class MessageOverlayMetricsV2 {
  const MessageOverlayMetricsV2._();

  static const double screenPadding = 16;
  static const double panelMinWidth = 176;
  static const double panelMaxWidth = 276;
  static const int actionColumns = 5;
  static const int actionVisibleSlots = actionColumns * 2;
  static const double actionRowHeight = 63;
  static const double separatorHeight = 1;
  static const double gap = 10;
  static const double reactionBarHeight = 44;
  static const double reactionPickerExpandedHeight = 250;
  static const double reactionPickerExpandedWidth = 340;

  static double actionPanelHeight(int actionCount) {
    if (actionCount <= 0) {
      return 0;
    }
    final rowCount = actionRowCount(actionCount);
    return (rowCount * actionRowHeight) + ((rowCount - 1) * separatorHeight);
  }

  static int actionRowCount(int actionCount) {
    if (actionCount <= 0) {
      return 0;
    }
    final visibleActionCount = actionCount > actionVisibleSlots
        ? actionVisibleSlots
        : actionCount;
    return ((visibleActionCount - 1) ~/ actionColumns) + 1;
  }
}
