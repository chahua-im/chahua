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
  testWidgets('renders forwarded preview messages and total count', (
    tester,
  ) async {
    await _pumpRow(tester, MessageRowV2(message: _forwardedMessage()));

    expect(find.text('Chat History'), findsOneWidget);
    expect(find.text('Bob: Hello @Carol'), findsOneWidget);
    expect(find.text('Carol: [Image]'), findsOneWidget);
    expect(find.text('Alice: See you tomorrow'), findsOneWidget);
    expect(find.text('Dave: Hidden fourth message'), findsNothing);
    expect(find.text('Forwarded 4 messages'), findsOneWidget);

    await tester.tap(find.text('Chat History'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(ForwardedMessagesViewer), findsOneWidget);
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
    content: const ForwardedPreviewContent(
      total: 4,
      previewMessages: <ForwardedMessagePreview>[
        ForwardedMessagePreview(
          originalMessageId: 10,
          originalChatId: 1,
          sender: User(uid: 2, name: 'Bob'),
          message: 'Hello @[uid:3]',
          messageType: 'text',
          mentions: <MentionInfo>[MentionInfo(uid: 3, username: 'Carol')],
        ),
        ForwardedMessagePreview(
          originalMessageId: 11,
          originalChatId: 1,
          sender: User(uid: 3, name: 'Carol'),
          messageType: 'text',
          firstAttachmentKind: 'image/png',
        ),
        ForwardedMessagePreview(
          originalMessageId: 12,
          originalChatId: 1,
          sender: User(uid: 1, name: 'Alice'),
          message: 'See you tomorrow',
          messageType: 'text',
        ),
      ],
    ),
  );
}
