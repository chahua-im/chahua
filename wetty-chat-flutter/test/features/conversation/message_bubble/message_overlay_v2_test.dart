import 'dart:ui' as ui;

import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/timeline/model/message_long_press_details_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_action_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_controls_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_reaction_picker_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

const _overlayBoundaryKey = ValueKey('message-overlay-v2-boundary');

void main() {
  testWidgets('expanded reaction picker paints above the action menu', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayV2(
        details: MessageLongPressDetailsV2(
          message: _textMessage(),
          bubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
          isMe: false,
          sourceShowsSenderName: false,
        ),
        visible: true,
        actions: _actions(),
        quickReactionEmojis: const ['👍', '❤️', '😂'],
        onDismiss: () {},
        onToggleReaction: (_) {},
      ),
      size: const Size(720, 780),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pumpAndSettle();

    final widgets = tester.allWidgets.toList();
    final actionPanelIndex = widgets.indexWhere(
      (widget) => widget is MessageOverlayActionPanelV2,
    );
    final reactionPickerIndex = widgets.indexWhere(
      (widget) => widget is MessageOverlayReactionBarV2,
    );

    expect(actionPanelIndex, isNot(-1));
    expect(reactionPickerIndex, isNot(-1));
    expect(actionPanelIndex, lessThan(reactionPickerIndex));
  });

  testWidgets('expanding reaction picker animates the overlay size', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayV2(
        details: MessageLongPressDetailsV2(
          message: _textMessage(),
          bubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
          isMe: false,
          sourceShowsSenderName: false,
        ),
        visible: true,
        actions: _actions(),
        quickReactionEmojis: const ['👍', '❤️', '😂'],
        onDismiss: () {},
        onToggleReaction: (_) {},
      ),
    );

    final reactionPicker = find.byType(MessageOverlayReactionBarV2);
    final collapsedHeight = tester.getSize(reactionPicker).height;

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 90));

    final animatingHeight = tester.getSize(reactionPicker).height;

    await tester.pumpAndSettle();

    final expandedHeight = tester.getSize(reactionPicker).height;

    expect(collapsedHeight, lessThan(expandedHeight));
    expect(animatingHeight, greaterThan(collapsedHeight));
    expect(animatingHeight, lessThan(expandedHeight));
  });

  testWidgets('expanded reaction picker corner background is not shadowed', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayV2(
        details: MessageLongPressDetailsV2(
          message: _textMessage(),
          bubbleRect: const Rect.fromLTWH(40, 360, 220, 80),
          isMe: false,
          sourceShowsSenderName: false,
        ),
        visible: true,
        actions: _actions(),
        quickReactionEmojis: const ['👍', '❤️', '😂'],
        onDismiss: () {},
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final pickerTopLeft = tester.getTopLeft(
      find.byType(MessageOverlayReactionBarV2),
    );
    final pickerSize = tester.getSize(find.byType(MessageOverlayReactionBarV2));
    final image = await _captureOverlayImage(tester);
    final cornerBackground = await _pixelAt(
      tester,
      image,
      (pickerTopLeft.dx + pickerSize.width - 4).round(),
      (pickerTopLeft.dy + pickerSize.height - 4).round(),
    );
    final adjacentBackground = await _pixelAt(
      tester,
      image,
      (pickerTopLeft.dx + pickerSize.width + 40).round(),
      (pickerTopLeft.dy + pickerSize.height - 4).round(),
    );

    expect(
      _colorDistance(cornerBackground, adjacentBackground),
      lessThanOrEqualTo(4),
      reason:
          'Rounded-corner background=$cornerBackground differs from '
          'adjacent background=$adjacentBackground.',
    );
  });
}

Future<void> _pumpWithSettings(
  WidgetTester tester,
  Widget child, {
  Size size = const Size(390, 780),
}) async {
  final preferences = AppPreferences.withData(const <String, Object>{});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: CupertinoPageScaffold(
          child: RepaintBoundary(
            key: _overlayBoundaryKey,
            child: SizedBox(
              width: size.width,
              height: size.height,
              child: child,
            ),
          ),
        ),
      ),
    ),
  );
}

List<MessageOverlayActionV2> _actions() {
  return [
    MessageOverlayActionV2(label: 'Reply', onPressed: () {}),
    MessageOverlayActionV2(label: 'Copy', onPressed: () {}),
    MessageOverlayActionV2(label: 'Edit', onPressed: () {}),
    MessageOverlayActionV2(label: 'Delete', onPressed: () {}),
  ];
}

ConversationMessageV2 _textMessage() {
  return ConversationMessageV2(
    clientGeneratedId: 'client-1',
    sender: const User(uid: 2, name: 'Sender'),
    createdAt: DateTime(2026, 5, 10, 12),
    content: const TextMessageContent(text: 'Hello'),
  );
}

Future<ui.Image> _captureOverlayImage(WidgetTester tester) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_overlayBoundaryKey),
  );
  final image = await tester.runAsync(() => boundary.toImage(pixelRatio: 1));
  if (image == null) {
    throw StateError('Unable to capture overlay image.');
  }
  return image;
}

Future<Color> _pixelAt(
  WidgetTester tester,
  ui.Image image,
  int x,
  int y,
) async {
  final data = await tester.runAsync(
    () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
  );
  if (data == null) {
    throw StateError('Unable to read overlay image bytes.');
  }
  final offset = ((y * image.width) + x) * 4;
  return Color.fromARGB(
    data.getUint8(offset + 3),
    data.getUint8(offset),
    data.getUint8(offset + 1),
    data.getUint8(offset + 2),
  );
}

int _colorDistance(Color a, Color b) {
  return (_channel(a.r) - _channel(b.r)).abs() +
      (_channel(a.g) - _channel(b.g)).abs() +
      (_channel(a.b) - _channel(b.b)).abs() +
      (_channel(a.a) - _channel(b.a)).abs();
}

int _channel(double value) => (value * 255).round().clamp(0, 255).toInt();
