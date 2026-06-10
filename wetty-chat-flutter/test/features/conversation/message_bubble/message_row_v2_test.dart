import 'package:chahua/core/network/api_config.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUp(() {
    ApiSession.updateSession(
      userId: 42,
      authHeaders: legacyApiAuthHeadersForUser(42),
    );
  });

  tearDown(() {
    ApiSession.updateSession(
      userId: 1,
      authHeaders: legacyApiAuthHeadersForUser(1),
    );
  });

  testWidgets('failed own local message shows side action beside the bubble', (
    tester,
  ) async {
    ConversationMessageV2? selectedMessage;

    await _pumpRow(
      tester,
      MessageRowV2(
        message: _message(
          senderUid: 42,
          deliveryState: ConversationDeliveryState.failed,
        ),
        onFailedMessageAction: (message) {
          selectedMessage = message;
        },
      ),
    );

    expect(find.byKey(messageRowFailedActionKey), findsOneWidget);

    await tester.tap(find.byKey(messageRowFailedActionKey));

    expect(selectedMessage?.clientGeneratedId, 'client-1');
  });

  testWidgets('side action is only shown for failed own local messages', (
    tester,
  ) async {
    await _pumpRow(
      tester,
      Column(
        children: [
          MessageRowV2(
            message: _message(senderUid: 7),
            onFailedMessageAction: (_) {},
          ),
          MessageRowV2(
            message: _message(senderUid: 42),
            onFailedMessageAction: (_) {},
          ),
          MessageRowV2(
            message: _message(
              senderUid: 42,
              deliveryState: ConversationDeliveryState.failed,
              serverMessageId: 10,
            ),
            onFailedMessageAction: (_) {},
          ),
          MessageRowV2(
            message: _message(
              senderUid: 7,
              deliveryState: ConversationDeliveryState.failed,
            ),
            onFailedMessageAction: (_) {},
          ),
          MessageRowV2(
            message: _message(
              senderUid: 42,
              deliveryState: ConversationDeliveryState.failed,
            ),
            onFailedMessageAction: (_) {},
          ),
        ],
      ),
    );

    expect(find.byKey(messageRowFailedActionKey), findsOneWidget);
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

ConversationMessageV2 _message({
  required int senderUid,
  ConversationDeliveryState deliveryState = ConversationDeliveryState.sending,
  int? serverMessageId,
}) {
  return ConversationMessageV2(
    serverMessageId: serverMessageId,
    clientGeneratedId: 'client-1',
    sender: User(uid: senderUid, name: 'Sender $senderUid'),
    createdAt: DateTime(2026, 6, 5, 12),
    deliveryState: deliveryState,
    content: const TextMessageContent(text: 'Hello'),
  );
}
