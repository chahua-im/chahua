import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:dio/dio.dart';

import 'package:chahua/app/app.dart';
import 'package:chahua/core/api/models/websocket_api_models.dart';
import 'package:chahua/core/network/websocket_service.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';

void main() {
  testWidgets('WettyChatApp builds a CupertinoApp.router shell', (
    WidgetTester tester,
  ) async {
    final prefs = AppPreferences.withData(const <String, Object>{});

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          authSessionProvider.overrideWith(_UnauthenticatedSessionNotifier.new),
        ],
        child: const WettyChatApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(CupertinoApp), findsOneWidget);
  });

  testWidgets(
    'WettyChatApp forwards background and foreground lifecycle updates to websocket service',
    (WidgetTester tester) async {
      final prefs = AppPreferences.withData(const <String, Object>{});
      final webSocketService = _LifecycleRecordingWebSocketService();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
            authSessionProvider.overrideWith(
              _UnauthenticatedSessionNotifier.new,
            ),
            webSocketProvider.overrideWithValue(webSocketService),
          ],
          child: const WettyChatApp(),
        ),
      );
      await tester.pumpAndSettle();

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();

      expect(webSocketService.recordedStates, [
        WsClientAppState.inactive,
        WsClientAppState.active,
      ]);
    },
  );
}

class _LifecycleRecordingWebSocketService extends WebSocketService {
  _LifecycleRecordingWebSocketService() : super(Dio());

  final List<WsClientAppState> recordedStates = <WsClientAppState>[];

  @override
  Future<void> init() async {}

  @override
  void updateAppState(WsClientAppState nextState) {
    recordedStates.add(nextState);
  }

  @override
  void dispose() {}
}

class _UnauthenticatedSessionNotifier extends AuthSessionNotifier {
  @override
  AuthSessionState build() {
    return const AuthSessionState(
      status: AuthBootstrapStatus.unauthenticated,
      mode: AuthSessionMode.none,
      developerUserId: 1,
      currentUserId: 1,
    );
  }
}
