import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/settings/app_settings_store.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const storageKey = 'appearance_color_theme_overrides';
  const customBadgeColor = Color(0xFF44AACC);

  Future<ProviderContainer> containerWithPrefs(
    Map<String, Object> initialValues,
  ) async {
    final prefs = AppPreferences.withData(initialValues);
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('missing color override storage produces empty overrides', () async {
    final container = await containerWithPrefs(const <String, Object>{});

    final settings = container.read(appSettingsProvider);

    expect(settings.colorThemeOverrides, const AppColorThemeOverrides());
    expect(settings.colorThemeOverrides.isEmpty, isTrue);
  });

  test('loads unread badge override from stored JSON', () async {
    final container = await containerWithPrefs({
      storageKey: '{"unreadBadge": ${customBadgeColor.toARGB32()}}',
    });

    final settings = container.read(appSettingsProvider);

    expect(settings.colorThemeOverrides.unreadBadge, customBadgeColor);
  });

  test('ignores malformed color override JSON', () async {
    final container = await containerWithPrefs({storageKey: 'not json'});

    final settings = container.read(appSettingsProvider);

    expect(settings.colorThemeOverrides, const AppColorThemeOverrides());
  });

  test('setting unread badge color writes one JSON preference entry', () async {
    final container = await containerWithPrefs(const <String, Object>{});
    final prefs = container.read(sharedPreferencesProvider);

    container
        .read(appSettingsProvider.notifier)
        .setUnreadBadgeColor(customBadgeColor);

    expect(
      prefs.getString(storageKey),
      '{"unreadBadge":${customBadgeColor.toARGB32()}}',
    );
  });

  test('reset removes color override storage when empty', () async {
    final container = await containerWithPrefs({
      storageKey: '{"unreadBadge": ${customBadgeColor.toARGB32()}}',
    });
    final prefs = container.read(sharedPreferencesProvider);

    container.read(appSettingsProvider.notifier).resetUnreadBadgeColor();

    expect(prefs.containsKey(storageKey), isFalse);
    expect(
      container.read(appSettingsProvider).colorThemeOverrides,
      const AppColorThemeOverrides(),
    );
  });

  test('resolved color theme applies overrides to both brightness modes', () {
    final overrides = AppColorThemeOverrides(unreadBadge: customBadgeColor);

    final light = AppColorTheme.resolve(
      brightness: Brightness.light,
      overrides: const AppColorThemeOverrides(),
    );
    final dark = AppColorTheme.resolve(
      brightness: Brightness.dark,
      overrides: const AppColorThemeOverrides(),
    );
    final customLight = AppColorTheme.resolve(
      brightness: Brightness.light,
      overrides: overrides,
    );
    final customDark = AppColorTheme.resolve(
      brightness: Brightness.dark,
      overrides: overrides,
    );

    expect(light.unreadBadge, const Color(0xFFE05144));
    expect(dark.unreadBadge, const Color(0xFFE05144));
    expect(customLight.unreadBadge, customBadgeColor);
    expect(customDark.unreadBadge, customBadgeColor);
  });

  test('badge text color is readable for light and dark badge colors', () {
    expect(
      AppColorTheme.badgeTextColorFor(const Color(0xFFFFFFFF)),
      CupertinoColors.black,
    );
    expect(
      AppColorTheme.badgeTextColorFor(const Color(0xFF000000)),
      CupertinoColors.white,
    );
  });
}
