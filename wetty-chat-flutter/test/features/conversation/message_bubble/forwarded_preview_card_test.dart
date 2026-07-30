import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/forwarded/forwarded_message_card.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('renders forwarded preview messages and total count', (
    tester,
  ) async {
    final api = _FakeMessageApiService();
    await _pumpRow(
      tester,
      MessageRowV2(message: _forwardedMessage()),
      api: api,
    );

    expect(find.text('Chat History'), findsOneWidget);
    expect(find.text('Bob: Hello @Carol'), findsOneWidget);
    expect(find.text('Carol: [Image]'), findsOneWidget);
    expect(find.text('Alice: See you tomorrow'), findsOneWidget);
    expect(find.text('Dave: Hidden fourth message'), findsNothing);
    expect(find.text('Forwarded 4 messages'), findsOneWidget);

    await tester.tap(find.text('Chat History'));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.byType(ForwardedMessagesViewer), findsOneWidget);
    expect(
      api.forwardedMessageRequests,
      <({int rootChatId, int rootMessageId, String forwardedBundleId})>[
        (rootChatId: 42, rootMessageId: 100, forwardedBundleId: 'root-bundle'),
      ],
    );
    expect(
      find.byKey(const ValueKey('forwarded-message-77-200')),
      findsOneWidget,
    );

    await tester.tap(find.text('Chat History').last);
    await tester.pump();
    await tester.pumpAndSettle();

    expect(api.forwardedMessageRequests, <
      ({int rootChatId, int rootMessageId, String forwardedBundleId})
    >[
      (rootChatId: 42, rootMessageId: 100, forwardedBundleId: 'root-bundle'),
      (rootChatId: 42, rootMessageId: 100, forwardedBundleId: 'nested-bundle'),
    ]);
  });
}

Future<void> _pumpRow(
  WidgetTester tester,
  Widget child, {
  required MessageApiServiceV2 api,
}) async {
  final preferences = AppPreferences.withData(const <String, Object>{});
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        messageApiServiceV2Provider.overrideWithValue(api),
      ],
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
    chatId: 42,
    clientGeneratedId: 'forwarded-card',
    sender: const User(uid: 1, name: 'Alice'),
    createdAt: DateTime(2026, 6, 26, 12),
    content: const ForwardedPreviewContent(
      total: 4,
      forwardedBundleId: 'root-bundle',
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
          attachmentKinds: ['image/png'],
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

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService() : super(Dio(), 1);

  final forwardedMessageRequests =
      <({int rootChatId, int rootMessageId, String forwardedBundleId})>[];

  @override
  Future<ForwardedMessagesResponseDto> fetchForwardedBundleMessages({
    required int rootChatId,
    required int rootMessageId,
    required String forwardedBundleId,
  }) async {
    forwardedMessageRequests.add((
      rootChatId: rootChatId,
      rootMessageId: rootMessageId,
      forwardedBundleId: forwardedBundleId,
    ));
    if (forwardedBundleId == 'nested-bundle') {
      return const ForwardedMessagesResponseDto(
        total: 1,
        messages: <ForwardedMessageResponseDto>[
          ForwardedMessageResponseDto(
            originalMessageId: 201,
            originalChatId: 77,
            message: 'Nested message',
            messageType: 'text',
            sender: UserDto(uid: 3, name: 'Carol'),
          ),
        ],
      );
    }
    return const ForwardedMessagesResponseDto(
      total: 1,
      messages: <ForwardedMessageResponseDto>[
        ForwardedMessageResponseDto(
          originalMessageId: 200,
          originalChatId: 77,
          forwardedBundleId: 'nested-bundle',
          message: 'Nested forwarded message',
          messageType: 'forwarded',
          sender: UserDto(uid: 2, name: 'Bob'),
        ),
      ],
    );
  }
}
