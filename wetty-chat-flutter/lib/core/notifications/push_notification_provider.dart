import 'dart:async';
import 'dart:developer' as developer;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../preferences/app_preferences.dart';
import '../providers/shared_preferences_provider.dart';
import '../session/dev_session_store.dart';
import 'push_api_service.dart';
import 'push_platform_client.dart';

class PushNotificationState {
  const PushNotificationState({
    this.isSupported = false,
    this.permissionStatus = 'notDetermined',
    this.deviceToken,
    this.provider,
    this.environment,
    this.isSubscribed = false,
    this.isLoading = false,
    this.lastError,
  });

  final bool isSupported;
  final String permissionStatus;
  final String? deviceToken;
  final String? provider;
  final String? environment;
  final bool isSubscribed;
  final bool isLoading;
  final String? lastError;

  bool get isAuthorized => permissionStatus == 'authorized';
  bool get isDenied => permissionStatus == 'denied';
  bool get isUnsupported => !isSupported || permissionStatus == 'unsupported';

  /// Has token + permission but backend subscription failed or not attempted.
  bool get needsSubscription =>
      isSupported &&
      isAuthorized &&
      deviceToken != null &&
      !isSubscribed &&
      !isLoading;

  PushNotificationState copyWith({
    bool? isSupported,
    String? permissionStatus,
    String? deviceToken,
    String? provider,
    String? environment,
    bool? isSubscribed,
    bool? isLoading,
    String? lastError,
    bool clearDeviceToken = false,
    bool clearError = false,
  }) {
    return PushNotificationState(
      isSupported: isSupported ?? this.isSupported,
      permissionStatus: permissionStatus ?? this.permissionStatus,
      deviceToken: clearDeviceToken ? null : (deviceToken ?? this.deviceToken),
      provider: provider ?? this.provider,
      environment: environment ?? this.environment,
      isSubscribed: isSubscribed ?? this.isSubscribed,
      isLoading: isLoading ?? this.isLoading,
      lastError: clearError ? null : (lastError ?? this.lastError),
    );
  }
}

class PushNotificationNotifier extends Notifier<PushNotificationState> {
  late AppPreferences _prefs;
  late PushPlatformClient _pushClient;
  late PushApiService _api;
  StreamSubscription<String>? _tokenSub;
  StreamSubscription<String>? _tokenErrorSub;

  @override
  PushNotificationState build() {
    _prefs = ref.read(sharedPreferencesProvider);
    _pushClient = ref.read(pushPlatformClientProvider);
    _api = ref.read(pushApiServiceProvider);

    // Restore persisted device token.
    final savedToken = _prefs.getString(_pushClient.tokenStorageKey);

    if (!_pushClient.isSupported) {
      return PushNotificationState(
        isSupported: false,
        permissionStatus: _pushClient.unsupportedPermissionStatus,
      );
    }

    // Listen for token updates and errors from native side.
    _tokenSub = _pushClient.onDeviceToken.listen(_onTokenReceived);
    _tokenErrorSub = _pushClient.onDeviceTokenError.listen(_onTokenError);
    ref.onDispose(() {
      _tokenSub?.cancel();
      _tokenErrorSub?.cancel();
    });

    // Kick off async initialization after returning initial state.
    Future.microtask(_initialize);

    return PushNotificationState(isSupported: true, deviceToken: savedToken);
  }

  /// Runs after build() — refreshes permission and auto-subscribes if possible.
  Future<void> _initialize() async {
    if (!_pushClient.isSupported) return;
    await _refreshPermissionStatus();

    // If we have a saved token and permission is granted, try to subscribe.
    // This handles the case where a previous subscribe call failed.
    final session = ref.read(authSessionProvider);
    if (state.needsSubscription && session.isAuthenticated) {
      await _doSubscribe();
    }
  }

  Future<void> _refreshPermissionStatus() async {
    try {
      final status = await _pushClient.getPermissionStatus();
      state = state.copyWith(permissionStatus: status);
    } catch (e) {
      developer.log(
        'Failed to get permission status: $e',
        name: 'PushNotification',
      );
    }
  }

  /// Request notification permission and register for remote notifications.
  /// Call this from the notification settings page or on first login.
  Future<void> requestPermissionAndRegister() async {
    if (!_pushClient.isSupported) return;
    state = state.copyWith(isLoading: true, clearError: true);
    try {
      final result = await _pushClient.requestPermission();
      state = state.copyWith(permissionStatus: result.status, isLoading: false);

      if (result.granted) {
        await _pushClient.registerForRemoteNotifications();
        // Token will arrive asynchronously via onDeviceToken stream.
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, lastError: e.toString());
    }
  }

  /// Re-register the current device token with the backend.
  /// Safe to call repeatedly — skips if already subscribed or in progress.
  /// Called on login, app resume, and after failed attempts.
  Future<void> ensureSubscribed() async {
    if (!_pushClient.isSupported) return;
    if (state.isSubscribed || state.isLoading) return;

    final session = ref.read(authSessionProvider);
    if (!session.isAuthenticated) return;

    if (state.needsSubscription) {
      await _doSubscribe();
    }
  }

  /// Manual retry — always attempts even if isSubscribed is true
  /// (re-registers in case the backend lost the token).
  Future<void> retrySubscription() async {
    if (!_pushClient.isSupported) return;
    final token = state.deviceToken;
    if (token == null) {
      // No token at all — re-request from native platform.
      if (state.isAuthorized) {
        state = state.copyWith(isLoading: true, clearError: true);
        await _pushClient.registerForRemoteNotifications();
        // Token arrives via stream → _onTokenReceived handles the rest.
      } else {
        await requestPermissionAndRegister();
      }
      return;
    }
    await _doSubscribe();
  }

  /// Unsubscribe from push notifications on the backend and unregister.
  Future<void> unsubscribe() async {
    if (!_pushClient.isSupported) return;
    final token = state.deviceToken;
    final descriptor = token == null
        ? null
        : await _resolveSubscriptionDescriptor(token);
    if (descriptor != null) {
      try {
        await _api.unsubscribe(descriptor);
        developer.log('Unsubscribed from push', name: 'PushNotification');
      } catch (e) {
        developer.log('Failed to unsubscribe: $e', name: 'PushNotification');
      }
    }
    state = state.copyWith(isSubscribed: false);
  }

  void _onTokenError(String error) {
    developer.log(
      'Token registration failed: $error',
      name: 'PushNotification',
    );
    state = state.copyWith(
      isLoading: false,
      lastError: _pushClient.tokenErrorMessage(error),
    );
  }

  void _onTokenReceived(String token) {
    developer.log('Token received, subscribing...', name: 'PushNotification');
    state = state.copyWith(deviceToken: token, clearError: true);
    _prefs.setString(_pushClient.tokenStorageKey, token);

    // Only auto-subscribe if the user is authenticated.
    final session = ref.read(authSessionProvider);
    if (session.isAuthenticated) {
      _doSubscribe();
    }
  }

  Future<void> _doSubscribe() async {
    final token = state.deviceToken;
    if (token == null) return;

    state = state.copyWith(isLoading: true, clearError: true);
    try {
      final descriptor = await _resolveSubscriptionDescriptor(token);
      if (descriptor == null) {
        state = state.copyWith(isLoading: false);
        return;
      }
      await _api.subscribe(descriptor);
      state = state.copyWith(isSubscribed: true, isLoading: false);
      developer.log(
        'Subscribed to push (provider=${descriptor.provider})',
        name: 'PushNotification',
      );
    } catch (e) {
      developer.log('Failed to subscribe: $e', name: 'PushNotification');
      state = state.copyWith(
        isSubscribed: false,
        isLoading: false,
        lastError: e.toString(),
      );
    }
  }

  /// Resolves backend registration fields from the current platform client.
  Future<PushSubscriptionDescriptor?> _resolveSubscriptionDescriptor(
    String token,
  ) async {
    final descriptor = await _pushClient.subscriptionDescriptorForToken(token);
    state = state.copyWith(
      provider: descriptor?.provider,
      environment: descriptor?.environment,
    );
    return descriptor;
  }
}

final pushNotificationProvider =
    NotifierProvider<PushNotificationNotifier, PushNotificationState>(
      PushNotificationNotifier.new,
    );
