import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/api/models/thread_api_models.dart';
import 'package:chahua/core/api/models/websocket_api_models.dart';
import 'package:chahua/core/api/services/chat_api_service.dart';
import 'package:chahua/core/api/services/thread_api_service.dart';
import 'package:chahua/core/notifications/apns_channel.dart';
import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_store.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_store.dart';
import 'package:chahua/features/chat_list/model/chat_list_item.dart';
import 'package:chahua/features/chat_list/model/thread_list_item.dart';
import 'package:chahua/features/shared/model/message/message.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('GroupListV2Store realtime projection', () {
    test(
      'known message from current user clears unread and updates preview',
      () {
        final container = _container();
        addTearDown(container.dispose);
        container
            .read(groupListV2StoreProvider.notifier)
            .replacePage(groups: [_chat(unreadCount: 3)]);

        final shouldRefresh = container
            .read(groupListV2StoreProvider.notifier)
            .applyRealtimeEvent(
              MessageCreatedWsEvent(
                payload: _message(id: 102, senderUid: 1, text: 'mine'),
              ),
            );

        final group = container.read(groupListV2StoreProvider).groups.single;
        expect(shouldRefresh, isFalse);
        expect(group.lastMessage?.messageId, 102);
        expect(group.lastMessage?.message, 'mine');
        expect(group.unreadCount, 0);
        expect(container.read(unreadBadgeProvider).chatUnreadTotal, 0);
      },
    );

    test('known message from another user increments unread', () {
      final container = _container();
      addTearDown(container.dispose);
      container
          .read(groupListV2StoreProvider.notifier)
          .replacePage(groups: [_chat(unreadCount: 2)]);

      final shouldRefresh = container
          .read(groupListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(id: 103, senderUid: 2, text: 'new'),
            ),
          );

      final group = container.read(groupListV2StoreProvider).groups.single;
      expect(shouldRefresh, isFalse);
      expect(group.lastMessage?.messageId, 103);
      expect(group.unreadCount, 3);
      expect(container.read(unreadBadgeProvider).chatUnreadTotal, 1);
    });

    test('unknown root message requests group refresh', () {
      final container = _container();
      addTearDown(container.dispose);

      final shouldRefresh = container
          .read(groupListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(id: 104, chatId: 999, senderUid: 2),
            ),
          );

      expect(shouldRefresh, isTrue);
    });

    test('thread reply does not request group refresh', () {
      final container = _container();
      addTearDown(container.dispose);

      final shouldRefresh = container
          .read(groupListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(id: 105, senderUid: 2, replyRootId: 200),
            ),
          );

      expect(shouldRefresh, isFalse);
    });
  });

  group('ThreadListV2Store realtime projection', () {
    test('known reply from current user clears unread and updates preview', () {
      final container = _container(threadUnreadTotal: 4);
      addTearDown(container.dispose);
      container
          .read(threadListV2StoreProvider.notifier)
          .replaceActivePage(threads: [_thread(unreadCount: 4)]);
      container.read(threadListV2StoreProvider.notifier).replaceUnreadTotals((
        activeThreadCount: 4,
        archivedThreadCount: 0,
        activeMessageCount: 0,
        archivedMessageCount: 0,
      ));

      final shouldRefresh = container
          .read(threadListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(
                id: 202,
                senderUid: 1,
                text: 'mine',
                replyRootId: 200,
              ),
            ),
          );

      final state = container.read(threadListV2StoreProvider);
      final thread = state.active.threads.single;
      expect(shouldRefresh, isFalse);
      expect(thread.lastReply?.messageId, 202);
      expect(thread.unreadCount, 0);
      expect(state.unreadTotals.activeThreadCount, 0);
      expect(container.read(unreadBadgeProvider).threadUnreadTotal, 0);
    });

    test('known reply from another user increments unread and reply count', () {
      final container = _container(threadUnreadTotal: 1);
      addTearDown(container.dispose);
      container
          .read(threadListV2StoreProvider.notifier)
          .replaceActivePage(threads: [_thread(unreadCount: 1, replyCount: 2)]);
      container.read(threadListV2StoreProvider.notifier).replaceUnreadTotals((
        activeThreadCount: 1,
        archivedThreadCount: 0,
        activeMessageCount: 0,
        archivedMessageCount: 0,
      ));

      final shouldRefresh = container
          .read(threadListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(
                id: 203,
                senderUid: 2,
                text: 'reply',
                replyRootId: 200,
              ),
            ),
          );

      final state = container.read(threadListV2StoreProvider);
      final thread = state.active.threads.single;
      expect(shouldRefresh, isFalse);
      expect(thread.lastReply?.messageId, 203);
      expect(thread.replyCount, 3);
      expect(thread.unreadCount, 2);
      expect(state.unreadTotals.activeThreadCount, 2);
      expect(container.read(unreadBadgeProvider).threadUnreadTotal, 1);
    });

    test('unknown reply requests thread refresh', () {
      final container = _container();
      addTearDown(container.dispose);

      final shouldRefresh = container
          .read(threadListV2StoreProvider.notifier)
          .applyRealtimeEvent(
            MessageCreatedWsEvent(
              payload: _message(id: 204, senderUid: 2, replyRootId: 999),
            ),
          );

      expect(shouldRefresh, isTrue);
    });

    test('server read state updates row and unread totals', () {
      final container = _container(threadUnreadTotal: 4);
      addTearDown(container.dispose);
      container
          .read(threadListV2StoreProvider.notifier)
          .replaceActivePage(threads: [_thread(unreadCount: 4)]);
      container.read(threadListV2StoreProvider.notifier).replaceUnreadTotals((
        activeThreadCount: 4,
        archivedThreadCount: 0,
        activeMessageCount: 0,
        archivedMessageCount: 0,
      ));
      container.read(unreadBadgeProvider.notifier).replaceThreadUnreadTotal(4);

      container
          .read(threadListV2StoreProvider.notifier)
          .applyServerReadState(
            threadRootId: 200,
            response: (lastReadMessageId: '203', unreadCount: 1),
          );

      final state = container.read(threadListV2StoreProvider);
      expect(state.active.threads.single.unreadCount, 1);
      expect(state.unreadTotals.activeThreadCount, 1);
      expect(container.read(unreadBadgeProvider).threadUnreadTotal, 1);
    });

    test(
      'server read state updates archived list without active badge delta',
      () {
        final container = _container(threadUnreadTotal: 4);
        addTearDown(container.dispose);
        container
            .read(threadListV2StoreProvider.notifier)
            .replaceArchivedPage(
              threads: [_thread(unreadCount: 3).copyWith(archived: true)],
            );
        container.read(threadListV2StoreProvider.notifier).replaceUnreadTotals((
          activeThreadCount: 4,
          archivedThreadCount: 3,
          activeMessageCount: 0,
          archivedMessageCount: 0,
        ));
        container
            .read(unreadBadgeProvider.notifier)
            .replaceThreadUnreadTotal(4);

        container
            .read(threadListV2StoreProvider.notifier)
            .applyServerReadState(
              threadRootId: 200,
              response: (lastReadMessageId: '203', unreadCount: 1),
            );

        final state = container.read(threadListV2StoreProvider);
        expect(state.archived.threads.single.unreadCount, 1);
        expect(state.unreadTotals.activeThreadCount, 4);
        expect(state.unreadTotals.archivedThreadCount, 1);
        expect(container.read(unreadBadgeProvider).threadUnreadTotal, 4);
      },
    );

    test('threadByIdProvider searches archived list', () {
      final container = _container();
      addTearDown(container.dispose);
      container
          .read(threadListV2StoreProvider.notifier)
          .replaceArchivedPage(threads: [_thread().copyWith(archived: true)]);

      final thread = container.read(
        threadByIdProvider((chatId: '10', threadRootId: '200')),
      );

      expect(thread, isNotNull);
      expect(thread!.archived, isTrue);
    });
  });
}

ProviderContainer _container({
  int chatUnreadTotal = 0,
  int threadUnreadTotal = 0,
}) {
  return ProviderContainer(
    overrides: [
      authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
      chatApiServiceProvider.overrideWithValue(
        _FakeChatApiService(unreadCount: chatUnreadTotal),
      ),
      threadApiServiceProvider.overrideWithValue(
        _FakeThreadApiService(unreadCount: threadUnreadTotal),
      ),
      apnsChannelProvider.overrideWithValue(_FakeApnsChannel()),
    ],
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
  _FakeChatApiService({required this.unreadCount}) : super(Dio());

  final int unreadCount;

  @override
  Future<UnreadCountResponseDto> fetchUnreadCount() async {
    return UnreadCountResponseDto(unreadCount: unreadCount);
  }
}

class _FakeThreadApiService extends ThreadApiService {
  _FakeThreadApiService({required this.unreadCount}) : super(Dio());

  final int unreadCount;

  @override
  Future<UnreadThreadCountResponseDto> fetchUnreadThreadCount() async {
    return UnreadThreadCountResponseDto(unreadThreadCount: unreadCount);
  }
}

class _FakeApnsChannel extends ApnsChannel {
  @override
  Future<void> clearBadge() async {}

  @override
  Future<void> setBadge(int count) async {}
}

ChatListItem _chat({int unreadCount = 0}) {
  return ChatListItem(
    id: '10',
    name: 'General',
    unreadCount: unreadCount,
    lastMessageAt: DateTime.parse('2026-04-12T12:00:00Z'),
    lastMessage: _preview(id: 101, senderUid: 2),
  );
}

ThreadListItem _thread({int unreadCount = 0, int replyCount = 1}) {
  return ThreadListItem(
    chatId: '10',
    chatName: 'General',
    threadRootMessage: _preview(id: 200, senderUid: 2, text: 'root'),
    lastReply: MessagePreview(
      messageId: 201,
      sender: const User(uid: 2, name: 'sender'),
      message: 'old reply',
    ),
    replyCount: replyCount,
    lastReplyAt: DateTime.parse('2026-04-12T12:01:00Z'),
    unreadCount: unreadCount,
  );
}

MessageItemDto _message({
  required int id,
  int chatId = 10,
  required int senderUid,
  String text = 'hello',
  int? replyRootId,
}) {
  return MessageItemDto(
    id: id,
    message: text,
    messageType: 'text',
    sender: UserDto(uid: senderUid, name: 'sender', gender: 0),
    chatId: chatId,
    createdAt: DateTime.parse('2026-04-12T12:02:00Z'),
    isEdited: false,
    isDeleted: false,
    clientGeneratedId: 'cg-$id',
    replyRootId: replyRootId,
    hasAttachments: false,
    attachments: const [],
  );
}

MessagePreview _preview({
  required int id,
  required int senderUid,
  String text = 'hello',
}) {
  return MessagePreview(
    messageId: id,
    clientGeneratedId: 'cg-$id',
    sender: User(uid: senderUid, name: 'sender'),
    message: text,
    messageType: 'text',
    createdAt: DateTime.parse('2026-04-12T12:02:00Z'),
  );
}
