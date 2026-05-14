import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/thread_api_models.dart';
import 'package:chahua/core/api/services/chat_api_service.dart';
import 'package:chahua/core/api/services/thread_api_service.dart';
import 'package:chahua/core/notifications/push_platform_client.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/shared/data/read_state_repository.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ReadStateRepository notification dismissal', () {
    test(
      'dismisses delivered chat notifications after chat is fully read',
      () async {
        final platform = _RecordingPushPlatformClient();
        final container = _container(
          platform: platform,
          messageApi: _FakeMessageApiService(),
        );
        addTearDown(container.dispose);

        container
            .read(readStateRepositoryProvider)
            .reportVisibleMessageRead(
              identity: const (chatId: 10, threadRootId: null),
              messageId: 42,
            );

        await _waitForReadFlush();

        expect(platform.dismissCalls, [const (chatId: 10, threadRootId: null)]);
      },
    );

    test(
      'does not dismiss delivered chat notifications when unread remains',
      () async {
        final platform = _RecordingPushPlatformClient();
        final container = _container(
          platform: platform,
          messageApi: _FakeMessageApiService(unreadCount: 2),
        );
        addTearDown(container.dispose);

        container
            .read(readStateRepositoryProvider)
            .reportVisibleMessageRead(
              identity: const (chatId: 10, threadRootId: null),
              messageId: 42,
            );

        await _waitForReadFlush();

        expect(platform.dismissCalls, isEmpty);
      },
    );

    test(
      'dismisses delivered thread notifications after thread is fully read',
      () async {
        final platform = _RecordingPushPlatformClient();
        final container = _container(
          platform: platform,
          threadApi: _FakeThreadApiService(),
        );
        addTearDown(container.dispose);

        container
            .read(readStateRepositoryProvider)
            .reportVisibleMessageRead(
              identity: const (chatId: 10, threadRootId: 77),
              messageId: 99,
            );

        await _waitForReadFlush();

        expect(platform.dismissCalls, [const (chatId: 10, threadRootId: 77)]);
      },
    );

    test(
      'does not dismiss delivered thread notifications when unread remains',
      () async {
        final platform = _RecordingPushPlatformClient();
        final container = _container(
          platform: platform,
          threadApi: _FakeThreadApiService(unreadCount: 3),
        );
        addTearDown(container.dispose);

        container
            .read(readStateRepositoryProvider)
            .reportVisibleMessageRead(
              identity: const (chatId: 10, threadRootId: 77),
              messageId: 99,
            );

        await _waitForReadFlush();

        expect(platform.dismissCalls, isEmpty);
      },
    );

    test('does not dismiss delivered notifications when read fails', () async {
      final platform = _RecordingPushPlatformClient();
      final container = _container(
        platform: platform,
        messageApi: _FakeMessageApiService(throwOnRead: true),
      );
      addTearDown(container.dispose);

      container
          .read(readStateRepositoryProvider)
          .reportVisibleMessageRead(
            identity: const (chatId: 10, threadRootId: null),
            messageId: 42,
          );

      await _waitForReadFlush();

      expect(platform.dismissCalls, isEmpty);
    });
  });
}

ProviderContainer _container({
  required _RecordingPushPlatformClient platform,
  _FakeMessageApiService? messageApi,
  _FakeThreadApiService? threadApi,
}) {
  return ProviderContainer(
    overrides: [
      authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
      messageApiServiceV2Provider.overrideWithValue(
        messageApi ?? _FakeMessageApiService(),
      ),
      chatApiServiceProvider.overrideWithValue(_FakeChatApiService()),
      threadApiServiceProvider.overrideWithValue(
        threadApi ?? _FakeThreadApiService(),
      ),
      pushPlatformClientProvider.overrideWithValue(platform),
    ],
  );
}

Future<void> _waitForReadFlush() async {
  await Future<void>.delayed(const Duration(milliseconds: 250));
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

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService({this.throwOnRead = false, this.unreadCount = 0})
    : super(Dio(), 1);

  final bool throwOnRead;
  final int unreadCount;

  @override
  Future<MarkChatReadStateResponseDto> markMessagesAsRead(
    String chatId,
    int messageId,
  ) async {
    if (throwOnRead) {
      throw StateError('read failed');
    }
    return MarkChatReadStateResponseDto(
      lastReadMessageId: messageId.toString(),
      unreadCount: unreadCount,
    );
  }
}

class _FakeChatApiService extends ChatApiService {
  _FakeChatApiService() : super(Dio());

  @override
  Future<UnreadCountResponseDto> fetchUnreadCount() async {
    return const UnreadCountResponseDto();
  }
}

class _FakeThreadApiService extends ThreadApiService {
  _FakeThreadApiService({this.unreadCount = 0}) : super(Dio());

  final int unreadCount;

  @override
  Future<MarkThreadReadResponseDto> markThreadAsRead(
    int threadRootId,
    int messageId,
  ) async {
    return MarkThreadReadResponseDto(
      lastReadMessageId: messageId.toString(),
      unreadCount: unreadCount,
    );
  }

  @override
  Future<UnreadThreadCountResponseDto> fetchUnreadThreadCount() async {
    return const UnreadThreadCountResponseDto();
  }
}

class _RecordingPushPlatformClient implements PushPlatformClient {
  final dismissCalls = <ConversationIdentity>[];

  @override
  bool get isSupported => true;

  @override
  String get tokenStorageKey => 'push_test_device_token';

  @override
  String get unsupportedPermissionStatus => 'unsupported';

  @override
  Stream<String> get onDeviceToken => const Stream<String>.empty();

  @override
  Stream<String> get onDeviceTokenError => const Stream<String>.empty();

  @override
  Stream<Map<String, dynamic>> get onNotificationTapped {
    return const Stream<Map<String, dynamic>>.empty();
  }

  @override
  Future<String> getPermissionStatus() async => 'authorized';

  @override
  Future<PushPermissionRequestResult> requestPermission() async {
    return const PushPermissionRequestResult(
      granted: true,
      status: 'authorized',
    );
  }

  @override
  Future<void> registerForRemoteNotifications() async {}

  @override
  Future<void> unregisterForRemoteNotifications() async {}

  @override
  Future<Map<String, dynamic>?> getLaunchNotification() async => null;

  @override
  Future<void> dismissDeliveredNotificationsForConversation({
    required int chatId,
    int? threadRootId,
  }) async {
    dismissCalls.add((chatId: chatId, threadRootId: threadRootId));
  }

  @override
  Future<PushSubscriptionDescriptor?> subscriptionDescriptorForToken(
    String token,
  ) async {
    return null;
  }

  @override
  String tokenErrorMessage(String error) => 'test registration failed: $error';
}
