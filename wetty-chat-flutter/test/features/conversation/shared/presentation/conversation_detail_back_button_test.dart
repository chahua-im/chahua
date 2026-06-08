import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/api/services/pinned_messages_api_service.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/chat_list/presentation/chat_workspace_layout_scope.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/shared/presentation/chat_detail_v2_view.dart';
import 'package:chahua/features/conversation/pins/domain/pinned_message.dart';
import 'package:chahua/features/groups/metadata/data/group_metadata_api_service.dart';
import 'package:chahua/features/groups/metadata/data/group_metadata_models.dart';
import 'package:chahua/features/groups/metadata/data/group_metadata_repository.dart';
import 'package:chahua/features/shared/data/read_state_repository.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('pushed split-layout chat detail lets Cupertino imply leading', (
    tester,
  ) async {
    await _pumpChatDetail(tester, showBackButton: true);

    final navigationBar = tester.widget<CupertinoNavigationBar>(
      find.byType(CupertinoNavigationBar),
    );
    expect(navigationBar.automaticallyImplyLeading, isTrue);
    expect(navigationBar.leading, isNull);
    expect(find.byType(CupertinoNavigationBarBackButton), findsOneWidget);
  });

  testWidgets(
    'ordinary split-layout chat detail keeps the leading slot empty',
    (tester) async {
      await _pumpChatDetail(tester);

      final navigationBar = tester.widget<CupertinoNavigationBar>(
        find.byType(CupertinoNavigationBar),
      );
      expect(navigationBar.automaticallyImplyLeading, isFalse);
      expect(navigationBar.leading, isNull);
      expect(find.byType(CupertinoNavigationBarBackButton), findsNothing);
    },
  );
}

Future<void> _pumpChatDetail(
  WidgetTester tester, {
  bool showBackButton = false,
}) async {
  final preferences = AppPreferences.withData(const <String, Object>{});

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
        messageApiServiceV2Provider.overrideWithValue(_FakeMessageApiService()),
        pinnedMessagesApiServiceProvider.overrideWithValue(
          _EmptyPinnedMessagesApiService(),
        ),
        groupMetadataRepositoryProvider.overrideWithValue(
          _FakeGroupMetadataRepository(),
        ),
        readStateRepositoryProvider.overrideWith(_NoopReadStateRepository.new),
      ],
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Navigator(
          pages: [
            const CupertinoPage<void>(
              child: CupertinoPageScaffold(child: SizedBox.shrink()),
            ),
            CupertinoPage<void>(
              child: ChatWorkspaceLayoutScope(
                isSplit: true,
                child: ChatDetailV2Page(
                  chatId: 42,
                  launchRequest: const LaunchRequest.message(messageId: 104),
                  showBackButton: showBackButton,
                ),
              ),
            ),
          ],
          onDidRemovePage: (_) {},
        ),
      ),
    ),
  );
}

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService() : super(Dio(), 7);

  @override
  Future<ListMessagesResponseDto> fetchConversationMessages(
    ConversationIdentity identity, {
    int? max,
    int? before,
    int? after,
    int? around,
  }) async {
    return ListMessagesResponseDto(
      messages: [
        MessageItemDto(
          id: 104,
          message: 'message 104',
          sender: const UserDto(uid: 7, name: 'Sender 7'),
          chatId: identity.chatId,
        ),
      ],
    );
  }

  @override
  Future<MarkChatReadStateResponseDto> markMessagesAsRead(
    String chatId,
    int messageId,
  ) async {
    return MarkChatReadStateResponseDto(
      lastReadMessageId: messageId.toString(),
    );
  }
}

class _EmptyPinnedMessagesApiService extends PinnedMessagesApiService {
  _EmptyPinnedMessagesApiService() : super(Dio());

  @override
  Future<List<PinnedMessage>> listPins(int chatId) async {
    return const <PinnedMessage>[];
  }
}

class _NoopReadStateRepository extends ReadStateRepository {
  _NoopReadStateRepository(super.ref);

  @override
  void reportVisibleMessageRead({
    required ConversationIdentity identity,
    required int messageId,
  }) {}
}

class _FakeGroupMetadataRepository extends GroupMetadataRepository {
  _FakeGroupMetadataRepository() : super(GroupMetadataApiService(Dio()));

  @override
  Future<ChatMetadata> fetchMetadata(String chatId) async {
    return ChatMetadata(id: chatId, name: 'General', myRole: 'member');
  }
}

class _AuthenticatedSessionNotifier extends AuthSessionNotifier {
  @override
  AuthSessionState build() {
    return const AuthSessionState(
      status: AuthBootstrapStatus.authenticated,
      mode: AuthSessionMode.devHeader,
      developerUserId: 7,
      currentUserId: 7,
    );
  }
}
