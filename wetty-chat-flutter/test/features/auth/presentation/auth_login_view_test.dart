import 'dart:async';

import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/auth/presentation/auth_login_view.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('login page renders username and password fields', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(await _buildTestApp());

    expect(find.byType(CupertinoTextField), findsNWidgets(2));
    expect(find.text('Username'), findsWidgets);
    expect(find.text('Password'), findsWidgets);
    expect(find.text('Login'), findsWidgets);
  });

  testWidgets('login page shows loading state while submitting', (
    WidgetTester tester,
  ) async {
    final completer = Completer<String?>();
    await tester.pumpWidget(
      await _buildTestApp(
        authApi: _WidgetTestAuthBootstrapApi(
          loginWithCredentialsHandler:
              ({required username, required password}) => completer.future,
        ),
      ),
    );

    await tester.enterText(find.byType(CupertinoTextField).at(0), 'alice');
    await tester.enterText(find.byType(CupertinoTextField).at(1), 'secret');
    await tester.tap(find.widgetWithText(CupertinoButton, 'Login'));
    await tester.pump();

    expect(find.byType(CupertinoActivityIndicator), findsOneWidget);

    completer.complete(null);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 10));
  });
}

Future<Widget> _buildTestApp({AuthBootstrapApi? authApi}) async {
  final prefs = AppPreferences.withData(const <String, Object>{});
  return ProviderScope(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs),
      if (authApi != null) authBootstrapApiProvider.overrideWithValue(authApi),
    ],
    child: CupertinoApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: const AuthLoginPage(),
    ),
  );
}

class _WidgetTestAuthBootstrapApi extends AuthBootstrapApi {
  _WidgetTestAuthBootstrapApi({this.loginWithCredentialsHandler})
    : super(Dio());

  final Future<String?> Function({
    required String username,
    required String password,
  })?
  loginWithCredentialsHandler;

  @override
  Future<String?> loginWithCredentials({
    required String username,
    required String password,
  }) async {
    return loginWithCredentialsHandler?.call(
      username: username,
      password: password,
    );
  }
}
