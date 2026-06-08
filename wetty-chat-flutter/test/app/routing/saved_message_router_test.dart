import 'dart:collection';

import 'package:chahua/app/routing/app_router.dart';
import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/api/models/saved_messages_api_models.dart';
import 'package:chahua/core/api/models/thread_api_models.dart';
import 'package:chahua/core/api/services/chat_api_service.dart';
import 'package:chahua/core/api/services/pinned_messages_api_service.dart';
import 'package:chahua/core/api/services/saved_messages_api_service.dart';
import 'package:chahua/core/api/services/thread_api_service.dart';
import 'package:chahua/core/network/websocket_service.dart';
import 'package:chahua/core/notifications/apns_channel.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/pins/domain/pinned_message.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
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
  testWidgets(
    'saved-message push to an already-open chat avoids duplicate shell keys',
    (tester) async {
      final savedMessagesApi = _FakeSavedMessagesApiService(
        responses: [
          ListSavedMessagesResponseDto(savedMessages: [_savedMessage(4)]),
        ],
      );
      final messageApi = _FakeMessageApiService();
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(
            AppPreferences.withData(const <String, Object>{}),
          ),
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
          savedMessagesApiServiceProvider.overrideWithValue(savedMessagesApi),
          messageApiServiceV2Provider.overrideWithValue(messageApi),
          pinnedMessagesApiServiceProvider.overrideWithValue(
            _EmptyPinnedMessagesApiService(),
          ),
          groupMetadataRepositoryProvider.overrideWithValue(
            _FakeGroupMetadataRepository(),
          ),
          readStateRepositoryProvider.overrideWith(
            _NoopReadStateRepository.new,
          ),
          chatApiServiceProvider.overrideWithValue(_FakeChatApiService()),
          threadApiServiceProvider.overrideWithValue(_FakeThreadApiService()),
          apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
          webSocketProvider.overrideWithValue(_NoopWebSocketService()),
        ],
      );
      final router = container.read(appRouterProvider);
      var didDispose = false;
      void disposeAll() {
        if (didDispose) {
          return;
        }
        didDispose = true;
        router.dispose();
        container.dispose();
      }

      addTearDown(disposeAll);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: CupertinoApp.router(
            routerConfig: router,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
          ),
        ),
      );
      await tester.pump();

      router.go(AppRoutes.chatDetail('42'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      router.push<void>(AppRoutes.savedMessages);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      await tester.tap(find.text('message 4'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(find.byType(CupertinoNavigationBarBackButton), findsWidgets);
      expect(messageApi.aroundRequests, contains(104));

      if (router.canPop()) {
        router.pop();
        await tester.pump();
      }
      await tester.pumpWidget(const SizedBox.shrink());
      disposeAll();
    },
  );
}

SavedMessageResponseDto _savedMessage(int id) {
  return SavedMessageResponseDto(
    id: id,
    originalChatId: 42,
    originalMessageId: 100 + id,
    originalSenderUid: 7,
    originalCreatedAt: DateTime.utc(2026, 1, id, 12),
    savedAt: DateTime.utc(2026, 2, id),
    message: 'message $id',
    messageType: 'text',
    sender: const SavedSenderSnapshotDto(uid: 7, name: 'Alice', gender: 0),
    chat: const SavedChatSnapshotDto(id: 42, name: 'General'),
    canLocateContext: true,
  );
}

class _FakeSavedMessagesApiService extends SavedMessagesApiService {
  _FakeSavedMessagesApiService({
    List<ListSavedMessagesResponseDto> responses = const [],
  }) : _responses = Queue.of(responses),
       super(Dio());

  final Queue<ListSavedMessagesResponseDto> _responses;

  @override
  Future<ListSavedMessagesResponseDto> listSavedMessages({
    int? limit,
    int? before,
  }) async {
    return _responses.removeFirst();
  }
}

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService() : super(Dio(), 7);

  final List<int> aroundRequests = <int>[];

  @override
  Future<ListMessagesResponseDto> fetchConversationMessages(
    ConversationIdentity identity, {
    int? max,
    int? before,
    int? after,
    int? around,
  }) async {
    if (around != null) {
      aroundRequests.add(around);
    }
    return const ListMessagesResponseDto(messages: <MessageItemDto>[]);
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

class _FakeGroupMetadataRepository extends GroupMetadataRepository {
  _FakeGroupMetadataRepository() : super(GroupMetadataApiService(Dio()));

  @override
  Future<ChatMetadata> fetchMetadata(String chatId) async {
    return ChatMetadata(id: chatId, name: 'General', myRole: 'member');
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

class _FakeChatApiService extends ChatApiService {
  _FakeChatApiService() : super(Dio());

  @override
  Future<UnreadCountResponseDto> fetchUnreadCount() async {
    return const UnreadCountResponseDto();
  }
}

class _FakeThreadApiService extends ThreadApiService {
  _FakeThreadApiService() : super(Dio());

  @override
  Future<UnreadThreadCountResponseDto> fetchUnreadThreadCount() async {
    return const UnreadThreadCountResponseDto();
  }
}

class _FakeApnsChannel extends ApnsChannel {
  @override
  Future<void> clearBadge() async {}

  @override
  Future<void> setBadge(int count) async {}
}

class _NoopWebSocketService extends WebSocketService {
  _NoopWebSocketService() : super(Dio());

  @override
  Future<void> init() async {}

  @override
  Future<void> refreshSession() async {}

  @override
  void dispose() {}
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
