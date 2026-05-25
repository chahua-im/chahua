import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_item.dart';
import 'package:chahua/features/conversation/timeline/model/message_long_press_details_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay/message_overlay_bubble_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart'
    hide MessageItem;
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show SelectionArea;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

void main() {
  testWidgets('overlay bubble renders main message text as selectable', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageOverlayBubbleV2(
        details: MessageLongPressDetailsV2(
          message: _textMessage(),
          bubbleRect: const Rect.fromLTWH(0, 0, 240, 80),
          isMe: false,
          sourceShowsSenderName: true,
        ),
      ),
    );

    expect(find.byType(SelectionArea), findsOneWidget);
  });

  testWidgets('normal message item keeps text non-selectable by default', (
    tester,
  ) async {
    await _pumpWithSettings(
      tester,
      MessageItem(
        message: _textMessage(),
        isMe: false,
        isInteractive: true,
        showSenderName: false,
      ),
    );

    expect(find.byType(SelectionArea), findsNothing);
  });
}

Future<void> _pumpWithSettings(WidgetTester tester, Widget child) async {
  final preferences = AppPreferences.withData(const <String, Object>{});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: CupertinoPageScaffold(
          child: Center(child: SizedBox(width: 320, child: child)),
        ),
      ),
    ),
  );
}

ConversationMessageV2 _textMessage() {
  return ConversationMessageV2(
    clientGeneratedId: 'client-1',
    sender: const User(uid: 2, name: 'Sender'),
    createdAt: DateTime(2026, 5, 10, 12),
    content: const TextMessageContent(text: 'Hello https://example.com'),
  );
}
