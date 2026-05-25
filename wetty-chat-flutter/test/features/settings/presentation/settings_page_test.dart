import 'package:chahua/app/theme/style_config.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/settings/app_settings_store.dart';
import 'package:chahua/features/settings/presentation/appearance/appearance_settings_view.dart';
import 'package:chahua/features/settings/presentation/appearance/badge_color_settings_view.dart';
import 'package:chahua/features/settings/presentation/general/cache_settings_view.dart';
import 'package:chahua/features/settings/presentation/general/general_settings_view.dart';
import 'package:chahua/features/settings/presentation/settings_components.dart';
import 'package:chahua/features/settings/presentation/settings_modal_page.dart';
import 'package:chahua/features/settings/presentation/settings_page.dart';
import 'package:chahua/l10n/app_localizations.dart';
import '../../../test_utils/path_provider_mock.dart';

void main() {
  setUpAll(setUpPathProviderMock);
  tearDownAll(tearDownPathProviderMock);

  testWidgets('settings page opens general submenu and cache page', (
    tester,
  ) async {
    final preferences = AppPreferences.withData(const <String, Object>{});
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
    );
    addTearDown(container.dispose);

    final router = GoRouter(
      initialLocation: '/settings',
      routes: [
        GoRoute(
          path: '/settings',
          builder: (context, state) => const SettingsPage(),
          routes: [
            GoRoute(
              path: 'general',
              builder: (context, state) => const GeneralSettingsPage(),
              routes: [
                GoRoute(
                  path: 'cache',
                  builder: (context, state) => const CacheSettingsPage(),
                ),
              ],
            ),
          ],
        ),
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: CupertinoApp.router(
          routerConfig: router,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('General'), findsOneWidget);
    expect(find.text('Appearance'), findsOneWidget);

    await tester.tap(find.text('General'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Language'), findsOneWidget);
    expect(find.text('Cache'), findsOneWidget);

    await tester.tap(find.text('Cache'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Storage Used'), findsOneWidget);
  });

  testWidgets('settings modal opens subpages in its local navigator', (
    tester,
  ) async {
    final preferences = AppPreferences.withData(const <String, Object>{});
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const CupertinoApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: SettingsModalPage(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('General'), findsOneWidget);

    await tester.tap(find.text('General'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Cache'), findsOneWidget);

    await tester.tap(find.text('Cache'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Storage Used'), findsOneWidget);
  });

  testWidgets('appearance page shows badge color swatch', (tester) async {
    final preferences = AppPreferences.withData(const <String, Object>{});
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: AppColorThemeScope(
          overrides: container.read(appSettingsProvider).colorThemeOverrides,
          child: const CupertinoApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: AppearanceSettingsPage(),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Badge Color'), findsOneWidget);
    expect(find.byType(SettingsActionRow), findsNWidgets(3));
  });

  testWidgets('badge color page reset clears custom override', (tester) async {
    final preferences = AppPreferences.withData({
      'appearance_color_theme_overrides': '{"unreadBadge": 4282682060}',
    });
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: AppColorThemeScope(
          overrides: container.read(appSettingsProvider).colorThemeOverrides,
          child: const CupertinoApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: BadgeColorSettingsPage(),
          ),
        ),
      ),
    );
    await tester.pump();

    await tester.tap(find.text('Reset to Default'));
    await tester.pump();

    expect(
      preferences.containsKey('appearance_color_theme_overrides'),
      isFalse,
    );
  });
}
