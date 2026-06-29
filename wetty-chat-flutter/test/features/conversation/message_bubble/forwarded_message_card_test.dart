import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/forwarded/forwarded_message_card.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('forwarded card opens a viewer with forwarded messages', (
    tester,
  ) async {
    await _pumpRow(tester, MessageRowV2(message: _forwardedMessage()));

    expect(find.text('Forwarded'), findsOneWidget);
    expect(find.text('2 messages'), findsOneWidget);

    await tester.tap(find.text('Forwarded'));
    await tester.pumpAndSettle();

    expect(find.byType(ForwardedMessagesViewer), findsOneWidget);
    expect(find.byType(MessageRowV2), findsNWidgets(2));
  });
}

Future<void> _pumpRow(WidgetTester tester, Widget child) async {
  final preferences = AppPreferences.withData(const <String, Object>{});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: CupertinoPageScaffold(
          child: Center(child: SizedBox(width: 360, child: child)),
        ),
      ),
    ),
  );
}

ConversationMessageV2 _forwardedMessage() {
  return ConversationMessageV2(
    serverMessageId: 100,
    clientGeneratedId: 'forwarded-card',
    sender: const User(uid: 1, name: 'Alice'),
    createdAt: DateTime(2026, 6, 26, 12),
    content: ForwardedMessageContent(
      messages: <ForwardedMessageSnapshot>[
        ForwardedMessageSnapshot(
          originalMessageId: 10,
          originalChatId: 1,
          sender: const User(uid: 2, name: 'Bob'),
          originalCreatedAt: DateTime(2026, 6, 26, 11),
          content: const TextMessageContent(text: 'First forwarded message'),
        ),
        ForwardedMessageSnapshot(
          originalMessageId: 11,
          originalChatId: 1,
          sender: const User(uid: 3, name: 'Carol'),
          originalCreatedAt: DateTime(2026, 6, 26, 11, 1),
          content: const TextMessageContent(text: 'Second forwarded message'),
        ),
      ],
    ),
  );
}
