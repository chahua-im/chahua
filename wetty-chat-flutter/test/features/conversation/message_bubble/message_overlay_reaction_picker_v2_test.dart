import 'dart:ui' as ui;

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_reaction_picker_v2.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:emoji_picker_flutter/emoji_picker_flutter.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _pickerBoundaryKey = ValueKey('message-overlay-reaction-picker-boundary');

void main() {
  testWidgets('collapsed quick row lays out without overflow', (tester) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂', '😮', '😢'],
        onToggleReaction: (_) {},
      ),
    );

    expect(tester.takeException(), isNull);
  });

  testWidgets('expand button opens the expanded emoji picker', (tester) async {
    final selected = <String>[];

    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: selected.add,
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pumpAndSettle();

    expect(selected, isEmpty);
    expect(
      find.byKey(const ValueKey('message-overlay-expanded-reaction-picker')),
      findsOneWidget,
    );
  });

  testWidgets('selecting an expanded emoji toggles that reaction', (
    tester,
  ) async {
    final selected = <String>[];

    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: selected.add,
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pumpAndSettle();
    final picker = tester.widget<EmojiPicker>(find.byType(EmojiPicker));
    picker.onEmojiSelected?.call(null, const Emoji('🔥', 'fire'));
    await tester.pumpAndSettle();

    expect(selected, ['🔥']);
  });

  testWidgets('expanded panel does not keep the interim popular emoji row', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('message-overlay-expanded-emoji-🔥')),
      findsNothing,
    );
  });

  testWidgets('expanded panel embeds the native emoji picker widget', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pumpAndSettle();

    expect(find.byType(EmojiPicker), findsOneWidget);
  });

  testWidgets('expanded picker content fades in while opening', (tester) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 90));

    final opacity = tester.widget<Opacity>(
      find.byKey(const ValueKey('message-overlay-expanded-picker-opacity')),
    );

    expect(opacity.opacity, greaterThan(0));
    expect(opacity.opacity, lessThan(1));
  });

  testWidgets('expanded picker rounded corner does not retain shadow pixels', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final image = await _capturePickerImage(tester);
    final cornerOutsideFill = await _pixelAt(tester, image, image.width - 4, 4);
    final bodyFill = await _pixelAt(
      tester,
      image,
      image.width ~/ 2,
      image.height ~/ 2,
    );

    expect(
      _channel(cornerOutsideFill.a),
      0,
      reason:
          'Corner outside the rounded fill should be transparent; '
          'actual corner=$cornerOutsideFill body=$bodyFill.',
    );
  });

  testWidgets('expanded picker rounded corner fill matches body fill', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final image = await _capturePickerImage(tester);
    final cornerFill = await _pixelAt(
      tester,
      image,
      image.width - 20,
      image.height - 20,
    );
    final bodyFill = await _pixelAt(
      tester,
      image,
      image.width ~/ 2,
      image.height - 20,
    );

    expect(
      _colorDistance(cornerFill, bodyFill),
      lessThanOrEqualTo(2),
      reason: 'Rounded corner fill=$cornerFill differs from body=$bodyFill.',
    );
  });

  testWidgets('expanded picker does not keep the compact row shadow', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final containers = tester.widgetList<AnimatedContainer>(
      find.byType(AnimatedContainer),
    );
    final pickerContainer = containers.firstWhere(
      (container) => container.decoration is BoxDecoration,
    );
    final decoration = pickerContainer.decoration! as BoxDecoration;

    expect(decoration.boxShadow, isNull);
  });

  testWidgets('empty recents label uses dark mode text color', (tester) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayReactionBarV2(
        emojis: const ['👍', '❤️', '😂'],
        onToggleReaction: (_) {},
      ),
      brightness: Brightness.dark,
    );

    await tester.tap(find.byIcon(CupertinoIcons.add));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final label = tester.widget<Text>(find.text('No Recents'));

    expect(label.style?.color, AppColorTheme.darkDefaults.textSecondary);
  });
}

Future<void> _pumpWithSettings(
  WidgetTester tester,
  Widget child, {
  Brightness brightness = Brightness.light,
}) async {
  SharedPreferences.setMockInitialValues({});
  final preferences = AppPreferences.withData(const <String, Object>{});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: MediaQuery(
          data: MediaQueryData(platformBrightness: brightness),
          child: CupertinoPageScaffold(
            child: Center(
              child: RepaintBoundary(
                key: _pickerBoundaryKey,
                child: SizedBox(width: 340, child: child),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

Future<ui.Image> _capturePickerImage(WidgetTester tester) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_pickerBoundaryKey),
  );
  final image = await tester.runAsync(() => boundary.toImage(pixelRatio: 1));
  if (image == null) {
    throw StateError('Unable to capture picker image.');
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
    throw StateError('Unable to read picker image bytes.');
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
