import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/api/models/thread_api_models.dart';
import 'package:chahua/core/api/services/chat_api_service.dart';
import 'package:chahua/core/api/services/thread_api_service.dart';
import 'package:chahua/core/notifications/apns_channel.dart';
import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_store.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_store.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_view_model.dart';
import 'package:chahua/features/shared/application/chat_inbox_reconciler.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ChatInboxReconciler', () {
    test('reconcile loads inbox state and refreshes badge totals', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final chatService = _FakeChatApiService(
        unreadCount: 4,
        chatResponses: [
          ListChatsResponseDto(
            chats: [
              ChatListItemDto(
                id: 10,
                name: 'General',
                unreadCount: 4,
                lastMessageAt: DateTime.parse('2026-04-12T12:00:00Z'),
                lastMessage: _preview(id: 101, text: 'hello'),
              ),
            ],
          ),
        ],
      );
      final threadService = _FakeThreadApiService(
        unreadCount: 2,
        threadResponses: [
          ListThreadsResponseDto(
            threads: [
              ThreadListItemDto(
                chatId: 10,
                chatName: 'General',
                threadRootMessage: _preview(id: 200, text: 'thread root'),
                lastReply: _preview(id: 201, text: 'thread reply'),
                lastReplyAt: DateTime.parse('2026-04-12T12:05:00Z'),
                unreadCount: 2,
                subscribedAt: null,
              ),
            ],
          ),
        ],
      );
      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
          sharedPreferencesProvider.overrideWithValue(prefs),
          chatApiServiceProvider.overrideWithValue(chatService),
          threadApiServiceProvider.overrideWithValue(threadService),
          apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
        ],
      );
      addTearDown(container.dispose);

      await container.read(chatInboxReconcilerProvider).reconcile();

      final groups = container.read(groupListV2ViewModelProvider).value;
      final threads = container.read(activeThreadListV2ViewModelProvider).value;
      final badge = container.read(unreadBadgeProvider);

      expect(groups?.groups, hasLength(1));
      expect(groups?.groups.single.id, '10');
      expect(threads?.threads, hasLength(1));
      expect(threads?.threads.single.threadRootId, 200);
      expect(badge.chatUnreadTotal, 4);
      expect(badge.threadUnreadTotal, 2);
      expect(badge.combinedUnreadTotal, 6);
      expect(chatService.fetchChatsCalls, 1);
      expect(threadService.fetchThreadsCalls, 2);
      expect(chatService.fetchUnreadCountCalls, greaterThanOrEqualTo(1));
      expect(threadService.fetchUnreadCountCalls, greaterThanOrEqualTo(1));
    });

    test(
      'reconcileGroups refreshes only groups and chat unread total',
      () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final chatService = _FakeChatApiService(
          unreadCount: 4,
          chatResponses: [
            ListChatsResponseDto(
              chats: [
                ChatListItemDto(
                  id: 10,
                  name: 'General',
                  unreadCount: 4,
                  lastMessageAt: DateTime.parse('2026-04-12T12:00:00Z'),
                  lastMessage: _preview(id: 101, text: 'hello'),
                ),
              ],
            ),
          ],
        );
        final threadService = _FakeThreadApiService(
          unreadCount: 2,
          threadResponses: [
            ListThreadsResponseDto(threads: [_threadDto()]),
          ],
        );
        final container = ProviderContainer(
          overrides: [
            authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
            sharedPreferencesProvider.overrideWithValue(prefs),
            chatApiServiceProvider.overrideWithValue(chatService),
            threadApiServiceProvider.overrideWithValue(threadService),
            apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
          ],
        );
        addTearDown(container.dispose);

        await container.read(chatInboxReconcilerProvider).reconcileGroups();

        expect(container.read(groupListV2StoreProvider).groups, hasLength(1));
        expect(
          container.read(threadListV2StoreProvider).active.threads,
          isEmpty,
        );
        expect(container.read(unreadBadgeProvider).chatUnreadTotal, 4);
        expect(chatService.fetchChatsCalls, 1);
        expect(threadService.fetchThreadsCalls, 0);
        expect(chatService.fetchUnreadCountCalls, greaterThanOrEqualTo(1));
      },
    );

    test('reconcileThreads refreshes only threads', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final chatService = _FakeChatApiService(
        unreadCount: 4,
        chatResponses: [
          ListChatsResponseDto(
            chats: [
              ChatListItemDto(
                id: 10,
                name: 'General',
                unreadCount: 4,
                lastMessageAt: DateTime.parse('2026-04-12T12:00:00Z'),
                lastMessage: _preview(id: 101, text: 'hello'),
              ),
            ],
          ),
        ],
      );
      final threadService = _FakeThreadApiService(
        unreadCount: 2,
        threadResponses: [
          ListThreadsResponseDto(threads: [_threadDto()]),
        ],
      );
      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
          sharedPreferencesProvider.overrideWithValue(prefs),
          chatApiServiceProvider.overrideWithValue(chatService),
          threadApiServiceProvider.overrideWithValue(threadService),
          apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
        ],
      );
      addTearDown(container.dispose);

      await container.read(chatInboxReconcilerProvider).reconcileThreads();

      expect(container.read(groupListV2StoreProvider).groups, isEmpty);
      expect(
        container.read(threadListV2StoreProvider).active.threads,
        hasLength(1),
      );
      expect(container.read(unreadBadgeProvider).threadUnreadTotal, 2);
      expect(chatService.fetchChatsCalls, 0);
      expect(threadService.fetchThreadsCalls, 2);
      expect(threadService.fetchUnreadCountCalls, greaterThanOrEqualTo(1));
    });
  });
}

ThreadListItemDto _threadDto() {
  return ThreadListItemDto(
    chatId: 10,
    chatName: 'General',
    threadRootMessage: _preview(id: 200, text: 'thread root'),
    lastReply: _preview(id: 201, text: 'thread reply'),
    lastReplyAt: DateTime.parse('2026-04-12T12:05:00Z'),
    unreadCount: 2,
    subscribedAt: null,
  );
}

class _AuthenticatedSessionNotifier extends AuthSessionNotifier {
  @override
  AuthSessionState build() {
    return const AuthSessionState(
      status: AuthBootstrapStatus.authenticated,
      mode: AuthSessionMode.devHeader,
      developerUserId: 1,
      currentUserId: 1,
    );
  }
}

class _FakeChatApiService extends ChatApiService {
  _FakeChatApiService({required this.unreadCount, required this.chatResponses})
    : super(Dio());

  final int unreadCount;
  final List<ListChatsResponseDto> chatResponses;
  int fetchChatsCalls = 0;
  int fetchUnreadCountCalls = 0;

  @override
  Future<ListChatsResponseDto> fetchChats({int? limit, String? after}) async {
    final index = fetchChatsCalls < chatResponses.length
        ? fetchChatsCalls
        : chatResponses.length - 1;
    fetchChatsCalls += 1;
    return chatResponses[index];
  }

  @override
  Future<UnreadCountResponseDto> fetchUnreadCount() async {
    fetchUnreadCountCalls += 1;
    return UnreadCountResponseDto(unreadCount: unreadCount);
  }
}

class _FakeThreadApiService extends ThreadApiService {
  _FakeThreadApiService({
    required this.unreadCount,
    required this.threadResponses,
  }) : super(Dio());

  final int unreadCount;
  final List<ListThreadsResponseDto> threadResponses;
  int fetchThreadsCalls = 0;
  int fetchUnreadCountCalls = 0;

  @override
  Future<ListThreadsResponseDto> fetchThreads({
    int? limit,
    String? before,
    bool? archived,
  }) async {
    final index = fetchThreadsCalls < threadResponses.length
        ? fetchThreadsCalls
        : threadResponses.length - 1;
    fetchThreadsCalls += 1;
    return threadResponses[index];
  }

  @override
  Future<UnreadThreadCountResponseDto> fetchUnreadThreadCount() async {
    fetchUnreadCountCalls += 1;
    return UnreadThreadCountResponseDto(unreadThreadCount: unreadCount);
  }
}

class _FakeApnsChannel extends ApnsChannel {
  @override
  Future<void> clearBadge() async {}

  @override
  Future<void> setBadge(int count) async {}
}

MessagePreviewDto _preview({required int id, required String text}) {
  return MessagePreviewDto(
    id: id,
    clientGeneratedId: 'cg-$id',
    message: text,
    messageType: 'text',
    sender: const UserDto(uid: 2, name: 'sender', gender: 0),
    createdAt: DateTime.parse('2026-04-12T12:00:00Z'),
  );
}
