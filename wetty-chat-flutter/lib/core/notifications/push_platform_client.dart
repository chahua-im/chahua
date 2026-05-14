import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'apns_channel.dart';

class PushPermissionRequestResult {
  const PushPermissionRequestResult({
    required this.granted,
    required this.status,
  });

  final bool granted;
  final String status;

  factory PushPermissionRequestResult.fromMap(Map<String, dynamic> map) {
    return PushPermissionRequestResult(
      granted: map['granted'] as bool? ?? false,
      status: map['status'] as String? ?? 'unknown',
    );
  }
}

class PushSubscriptionDescriptor {
  const PushSubscriptionDescriptor({
    required this.provider,
    required this.deviceToken,
    this.environment,
  });

  final String provider;
  final String deviceToken;
  final String? environment;

  Map<String, dynamic> toJson() {
    return <String, dynamic>{
      'provider': provider,
      'deviceToken': deviceToken,
      'environment': ?environment,
    };
  }

  Map<String, String> toQueryParameters() {
    return <String, String>{
      'provider': provider,
      'deviceToken': deviceToken,
      'environment': ?environment,
    };
  }
}

abstract class PushPlatformClient {
  bool get isSupported;
  String get tokenStorageKey;
  String get unsupportedPermissionStatus;
  Stream<String> get onDeviceToken;
  Stream<String> get onDeviceTokenError;
  Stream<Map<String, dynamic>> get onNotificationTapped;

  Future<String> getPermissionStatus();
  Future<PushPermissionRequestResult> requestPermission();
  Future<void> registerForRemoteNotifications();
  Future<void> unregisterForRemoteNotifications();
  Future<Map<String, dynamic>?> getLaunchNotification();
  Future<void> dismissDeliveredNotificationsForConversation({
    required int chatId,
    int? threadRootId,
  });
  Future<PushSubscriptionDescriptor?> subscriptionDescriptorForToken(
    String token,
  );

  String tokenErrorMessage(String error);
}

class ApnsPushPlatformClient implements PushPlatformClient {
  const ApnsPushPlatformClient(this._apns);

  final ApnsChannel _apns;

  @override
  bool get isSupported => true;

  @override
  String get tokenStorageKey => 'push_apns_device_token';

  @override
  String get unsupportedPermissionStatus => 'unsupported';

  @override
  Stream<String> get onDeviceToken => _apns.onDeviceToken;

  @override
  Stream<String> get onDeviceTokenError => _apns.onDeviceTokenError;

  @override
  Stream<Map<String, dynamic>> get onNotificationTapped =>
      _apns.onNotificationTapped;

  @override
  Future<String> getPermissionStatus() => _apns.getPermissionStatus();

  @override
  Future<PushPermissionRequestResult> requestPermission() async {
    final result = await _apns.requestPermission();
    return PushPermissionRequestResult.fromMap(result);
  }

  @override
  Future<void> registerForRemoteNotifications() {
    return _apns.registerForRemoteNotifications();
  }

  @override
  Future<void> unregisterForRemoteNotifications() {
    return _apns.unregisterForRemoteNotifications();
  }

  @override
  Future<Map<String, dynamic>?> getLaunchNotification() {
    return _apns.getLaunchNotification();
  }

  @override
  Future<void> dismissDeliveredNotificationsForConversation({
    required int chatId,
    int? threadRootId,
  }) {
    return _apns.dismissDeliveredNotificationsForConversation(
      chatId: chatId,
      threadRootId: threadRootId,
    );
  }

  @override
  Future<PushSubscriptionDescriptor> subscriptionDescriptorForToken(
    String token,
  ) async {
    String environment;
    try {
      environment = await _apns.getApnsEnvironment();
    } catch (_) {
      environment = 'production';
    }
    return PushSubscriptionDescriptor(
      provider: 'apns',
      deviceToken: token,
      environment: environment,
    );
  }

  @override
  String tokenErrorMessage(String error) => 'APNs registration failed: $error';
}

class UnsupportedPushPlatformClient implements PushPlatformClient {
  const UnsupportedPushPlatformClient();

  @override
  bool get isSupported => false;

  @override
  String get tokenStorageKey => 'push_unsupported_device_token';

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
  Future<String> getPermissionStatus() async => unsupportedPermissionStatus;

  @override
  Future<PushPermissionRequestResult> requestPermission() async {
    return PushPermissionRequestResult(
      granted: false,
      status: unsupportedPermissionStatus,
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
  }) async {}

  @override
  Future<PushSubscriptionDescriptor?> subscriptionDescriptorForToken(
    String token,
  ) async {
    return null;
  }

  @override
  String tokenErrorMessage(String error) => 'Push registration failed: $error';
}

final pushPlatformClientProvider = Provider<PushPlatformClient>((ref) {
  if (Platform.isIOS) {
    return ApnsPushPlatformClient(ref.watch(apnsChannelProvider));
  }
  return const UnsupportedPushPlatformClient();
});
