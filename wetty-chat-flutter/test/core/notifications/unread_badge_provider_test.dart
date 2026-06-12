import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/thread_api_models.dart';
import 'package:chahua/core/api/services/chat_api_service.dart';
import 'package:chahua/core/api/services/thread_api_service.dart';
import 'package:chahua/core/notifications/apns_channel.dart';
import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('UnreadBadgeNotifier', () {
    test('refresh stores backend unread summary counts', () async {
      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
          chatApiServiceProvider.overrideWithValue(
            _FakeChatApiService(
              unreadCount: 7,
              archivedUnreadCount: 11,
              unreadChatCount: 2,
              archivedUnreadChatCount: 3,
            ),
          ),
          threadApiServiceProvider.overrideWithValue(
            _FakeThreadApiService(
              unreadThreadCount: 3,
              archivedUnreadThreadCount: 4,
              unreadMessageCount: 5,
              archivedUnreadMessageCount: 13,
            ),
          ),
          apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
        ],
      );
      addTearDown(container.dispose);

      await container.read(unreadBadgeProvider.notifier).refresh();
      final state = container.read(unreadBadgeProvider);

      expect(state.chatUnreadTotal, 7);
      expect(state.threadUnreadTotal, 3);
      expect(state.combinedUnreadTotal, 10);
      expect(state.chatUnreadMessageCount, 7);
      expect(state.archivedChatUnreadMessageCount, 11);
      expect(state.threadUnreadMessageCount, 5);
      expect(state.archivedThreadUnreadMessageCount, 13);
      expect(state.chatUnreadItemCount, 2);
      expect(state.archivedChatUnreadItemCount, 3);
      expect(state.threadUnreadItemCount, 3);
      expect(state.archivedThreadUnreadItemCount, 4);
      expect(state.activeUnreadMessageCount, 12);
      expect(state.archivedUnreadMessageCount, 24);
      expect(state.activeUnreadItemCount, 5);
      expect(state.archivedUnreadItemCount, 7);
      expect(state.isRefreshing, isFalse);
    });

    test('delta helpers update totals without going negative', () {
      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
          chatApiServiceProvider.overrideWithValue(
            _FakeChatApiService(unreadCount: 0),
          ),
          threadApiServiceProvider.overrideWithValue(
            _FakeThreadApiService(unreadThreadCount: 0),
          ),
          apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(unreadBadgeProvider.notifier);
      notifier.applyChatUnreadDelta(5);
      notifier.applyThreadUnreadDelta(2);
      notifier.applyChatUnreadDelta(-10);

      final state = container.read(unreadBadgeProvider);
      expect(state.chatUnreadTotal, 0);
      expect(state.threadUnreadTotal, 2);
      expect(state.combinedUnreadTotal, 2);
    });
  });

  group('chatBadgeContribution', () {
    test('returns zero for muted chats', () {
      final mutedUntil = DateTime.now().add(const Duration(minutes: 5));

      expect(chatBadgeContribution(unreadCount: 9, mutedUntil: mutedUntil), 0);
    });

    test('returns unread count when chat is not muted', () {
      expect(chatBadgeContribution(unreadCount: 4, mutedUntil: null), 4);
    });
  });
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
  _FakeChatApiService({
    required this.unreadCount,
    this.archivedUnreadCount = 0,
    this.unreadChatCount = 0,
    this.archivedUnreadChatCount = 0,
  }) : super(Dio());

  final int unreadCount;
  final int archivedUnreadCount;
  final int unreadChatCount;
  final int archivedUnreadChatCount;

  @override
  Future<UnreadCountResponseDto> fetchUnreadCount() async {
    return UnreadCountResponseDto(
      unreadCount: unreadCount,
      archivedUnreadCount: archivedUnreadCount,
      unreadChatCount: unreadChatCount,
      archivedUnreadChatCount: archivedUnreadChatCount,
    );
  }
}

class _FakeThreadApiService extends ThreadApiService {
  _FakeThreadApiService({
    required this.unreadThreadCount,
    this.archivedUnreadThreadCount = 0,
    this.unreadMessageCount = 0,
    this.archivedUnreadMessageCount = 0,
  }) : super(Dio());

  final int unreadThreadCount;
  final int archivedUnreadThreadCount;
  final int unreadMessageCount;
  final int archivedUnreadMessageCount;

  @override
  Future<UnreadThreadCountResponseDto> fetchUnreadThreadCount() async {
    return UnreadThreadCountResponseDto(
      unreadThreadCount: unreadThreadCount,
      archivedUnreadThreadCount: archivedUnreadThreadCount,
      unreadMessageCount: unreadMessageCount,
      archivedUnreadMessageCount: archivedUnreadMessageCount,
    );
  }
}

class _FakeApnsChannel extends ApnsChannel {
  @override
  Future<void> clearBadge() async {}

  @override
  Future<void> setBadge(int count) async {}
}
