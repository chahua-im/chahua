import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:chahua/core/notifications/push_api_service.dart';
import 'package:chahua/core/notifications/push_notification_provider.dart';
import 'package:chahua/core/notifications/push_platform_client.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PushNotificationNotifier', () {
    test('unsupported platform starts unavailable and no-ops', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final api = _RecordingPushApiService();
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          pushPlatformClientProvider.overrideWithValue(
            const UnsupportedPushPlatformClient(),
          ),
          pushApiServiceProvider.overrideWithValue(api),
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(pushNotificationProvider.notifier);
      final state = container.read(pushNotificationProvider);

      expect(state.isUnsupported, isTrue);
      expect(state.permissionStatus, 'unsupported');
      await notifier.requestPermissionAndRegister();
      await notifier.ensureSubscribed();
      await notifier.retrySubscription();
      await notifier.unsubscribe();
      expect(api.subscribeCalls, isEmpty);
      expect(api.unsubscribeCalls, isEmpty);
    });

    test('subscribes received platform token with descriptor', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final platform = _FakePushPlatformClient(
        permissionStatus: 'authorized',
        descriptor: const PushSubscriptionDescriptor(
          provider: 'apns',
          deviceToken: 'token-1',
          environment: 'sandbox',
        ),
      );
      final api = _RecordingPushApiService();
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          pushPlatformClientProvider.overrideWithValue(platform),
          pushApiServiceProvider.overrideWithValue(api),
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
        ],
      );
      addTearDown(container.dispose);
      container.read(pushNotificationProvider);

      platform.emitToken('token-1');
      await Future<void>.delayed(Duration.zero);

      final state = container.read(pushNotificationProvider);
      expect(state.deviceToken, 'token-1');
      expect(state.provider, 'apns');
      expect(state.environment, 'sandbox');
      expect(state.isSubscribed, isTrue);
      expect(api.subscribeCalls, hasLength(1));
      expect(api.subscribeCalls.single.deviceToken, 'token-1');
      expect(prefs.getString(platform.tokenStorageKey), 'token-1');
    });

    test('authorized retry registers when token is missing', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final platform = _FakePushPlatformClient(permissionStatus: 'authorized');
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          pushPlatformClientProvider.overrideWithValue(platform),
          pushApiServiceProvider.overrideWithValue(_RecordingPushApiService()),
          authSessionProvider.overrideWith(_AuthenticatedSessionNotifier.new),
        ],
      );
      addTearDown(container.dispose);
      container.read(pushNotificationProvider);

      await Future<void>.delayed(Duration.zero);
      await container
          .read(pushNotificationProvider.notifier)
          .retrySubscription();

      expect(platform.registerCalls, 1);
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

class _RecordingPushApiService extends PushApiService {
  _RecordingPushApiService() : super(Dio());

  final subscribeCalls = <PushSubscriptionDescriptor>[];
  final unsubscribeCalls = <PushSubscriptionDescriptor>[];

  @override
  Future<void> subscribe(PushSubscriptionDescriptor descriptor) async {
    subscribeCalls.add(descriptor);
  }

  @override
  Future<void> unsubscribe(PushSubscriptionDescriptor descriptor) async {
    unsubscribeCalls.add(descriptor);
  }
}

class _FakePushPlatformClient implements PushPlatformClient {
  _FakePushPlatformClient({
    this.permissionStatus = 'notDetermined',
    this.descriptor,
  });

  final String permissionStatus;
  final PushSubscriptionDescriptor? descriptor;
  final _tokenController = StreamController<String>.broadcast();
  final _tokenErrorController = StreamController<String>.broadcast();
  final _tapController = StreamController<Map<String, dynamic>>.broadcast();
  int registerCalls = 0;

  void emitToken(String token) => _tokenController.add(token);

  @override
  bool get isSupported => true;

  @override
  String get tokenStorageKey => 'push_test_device_token';

  @override
  String get unsupportedPermissionStatus => 'unsupported';

  @override
  Stream<String> get onDeviceToken => _tokenController.stream;

  @override
  Stream<String> get onDeviceTokenError => _tokenErrorController.stream;

  @override
  Stream<Map<String, dynamic>> get onNotificationTapped =>
      _tapController.stream;

  @override
  Future<String> getPermissionStatus() async => permissionStatus;

  @override
  Future<PushPermissionRequestResult> requestPermission() async {
    return PushPermissionRequestResult(
      granted: false,
      status: permissionStatus,
    );
  }

  @override
  Future<void> registerForRemoteNotifications() async {
    registerCalls += 1;
  }

  @override
  Future<void> unregisterForRemoteNotifications() async {}

  @override
  Future<Map<String, dynamic>?> getLaunchNotification() async => null;

  @override
  Future<void> dismissDeliveredNotificationsForConversation({
    required int chatId,
    int? threadRootId,
  }) async {}

  @override
  Future<PushSubscriptionDescriptor?> subscriptionDescriptorForToken(
    String token,
  ) async {
    return descriptor;
  }

  @override
  String tokenErrorMessage(String error) => 'test registration failed: $error';
}
