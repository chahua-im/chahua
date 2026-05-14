import 'dart:async';
import 'dart:developer' as developer;

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Dart wrapper around the native APNs MethodChannel.
///
/// Exposes async methods for permission/registration and streams for
/// device token updates and notification tap events from Swift.
class ApnsChannel {
  ApnsChannel()
    : _channel = const MethodChannel('app.chahua.chat/push_notifications') {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  final MethodChannel _channel;

  final _deviceTokenController = StreamController<String>.broadcast();
  final _notificationTapController =
      StreamController<Map<String, dynamic>>.broadcast();
  final _deviceTokenErrorController = StreamController<String>.broadcast();

  /// Fires whenever iOS provides a new APNs device token.
  Stream<String> get onDeviceToken => _deviceTokenController.stream;

  /// Fires when the user taps a push notification.
  Stream<Map<String, dynamic>> get onNotificationTapped =>
      _notificationTapController.stream;

  /// Fires when iOS fails to register for remote notifications.
  Stream<String> get onDeviceTokenError => _deviceTokenErrorController.stream;

  /// Request notification permission (alert, badge, sound).
  /// Returns `{"granted": bool, "status": String}`.
  Future<Map<String, dynamic>> requestPermission() async {
    final result = await _channel.invokeMapMethod<String, dynamic>(
      'requestPermission',
    );
    return result ?? {'granted': false, 'status': 'unknown'};
  }

  /// Returns current permission status without prompting.
  Future<String> getPermissionStatus() async {
    final result = await _channel.invokeMethod<String>('getPermissionStatus');
    return result ?? 'unknown';
  }

  /// Triggers iOS to register for remote notifications.
  /// The actual token arrives asynchronously via [onDeviceToken].
  Future<void> registerForRemoteNotifications() =>
      _channel.invokeMethod<void>('registerForRemoteNotifications');

  /// Unregisters from remote notifications.
  Future<void> unregisterForRemoteNotifications() =>
      _channel.invokeMethod<void>('unregisterForRemoteNotifications');

  /// Returns `"sandbox"` or `"production"` based on the build's APNs entitlement.
  Future<String> getApnsEnvironment() async {
    final result = await _channel.invokeMethod<String>('getApnsEnvironment');
    return result ?? 'production';
  }

  /// Sets the app icon badge count.
  Future<void> setBadge(int count) =>
      _channel.invokeMethod<void>('setBadge', {'count': count});

  /// Clears the app icon badge count.
  Future<void> clearBadge() => _channel.invokeMethod<void>('clearBadge');

  /// Dismisses delivered notifications for a chat or one of its threads.
  Future<void> dismissDeliveredNotificationsForConversation({
    required int chatId,
    int? threadRootId,
  }) {
    return _channel.invokeMethod<void>(
      'dismissDeliveredNotificationsForConversation',
      <String, dynamic>{
        'chatId': chatId.toString(),
        'threadRootId': ?threadRootId?.toString(),
      },
    );
  }

  /// Returns the notification payload that launched the app (cold start),
  /// or `null` if the app was not launched from a notification.
  Future<Map<String, dynamic>?> getLaunchNotification() async {
    final result = await _channel.invokeMapMethod<String, dynamic>(
      'getLaunchNotification',
    );
    return result;
  }

  // -- Native → Dart callback handler --

  Future<dynamic> _handleNativeCall(MethodCall call) async {
    switch (call.method) {
      case 'onDeviceTokenReceived':
        final args = Map<String, dynamic>.from(call.arguments as Map);
        final token = args['deviceToken'] as String;
        developer.log(
          'Received APNs device token: ${token.substring(0, 8)}...',
          name: 'ApnsChannel',
        );
        _deviceTokenController.add(token);
      case 'onDeviceTokenError':
        final args = Map<String, dynamic>.from(call.arguments as Map);
        final error = args['error'] as String;
        developer.log('APNs token error: $error', name: 'ApnsChannel');
        _deviceTokenErrorController.add(error);
      case 'onNotificationTapped':
        final payload = Map<String, dynamic>.from(call.arguments as Map);
        developer.log(
          'Notification tapped: chatId=${payload['chatId']}',
          name: 'ApnsChannel',
        );
        _notificationTapController.add(payload);
    }
  }

  void dispose() {
    _deviceTokenController.close();
    _notificationTapController.close();
    _deviceTokenErrorController.close();
  }
}

final apnsChannelProvider = Provider<ApnsChannel>((ref) {
  final channel = ApnsChannel();
  ref.onDispose(channel.dispose);
  return channel;
});
