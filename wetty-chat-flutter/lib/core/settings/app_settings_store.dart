import 'dart:convert';
import 'dart:ui';

import 'package:chahua/app/theme/style_config.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/app_localizations.dart';
import '../preferences/app_preferences.dart';
import '../providers/shared_preferences_provider.dart';

enum AppLanguage {
  system('system'),
  english('english'),
  chineseCN('chinese_cn'),
  chineseTW('chinese_tw');

  const AppLanguage(this.storageValue);

  final String storageValue;

  static AppLanguage fromStorage(String? value) {
    // Migrate old 'chinese' value to 'chinese_cn'
    if (value == 'chinese') return AppLanguage.chineseCN;
    return AppLanguage.values.firstWhere(
      (language) => language.storageValue == value,
      orElse: () => AppLanguage.system,
    );
  }

  /// Returns the locale for this language setting, or null for system default.
  Locale? toLocale() {
    return switch (this) {
      AppLanguage.system => null,
      AppLanguage.english => const Locale('en'),
      AppLanguage.chineseCN => const Locale('zh', 'CN'),
      AppLanguage.chineseTW => const Locale('zh', 'TW'),
    };
  }
}

extension AppLanguageDisplayName on AppLanguage {
  String displayName(AppLocalizations l10n) => switch (this) {
    AppLanguage.system => l10n.languageSystem,
    AppLanguage.english => l10n.languageEnglish,
    AppLanguage.chineseCN => l10n.languageChineseCN,
    AppLanguage.chineseTW => l10n.languageChineseTW,
  };
}

typedef AppSettingsState = ({
  double fontSize,
  AppLanguage language,
  bool showAllTab,
  AppColorThemeOverrides colorThemeOverrides,
});

class AppSettingsNotifier extends Notifier<AppSettingsState> {
  static const String _chatMessageFontSizeKey = 'chat_message_font_size';
  static const String _languageKey = 'app_language';
  static const String _showAllTabKey = 'chat_list_show_all_tab';
  static const String _colorThemeOverridesKey =
      'appearance_color_theme_overrides';
  static const double minChatMessageFontSize = 14;
  static const double maxChatMessageFontSize = 18;
  static const int chatMessageFontSizeSteps = 5;
  static const double defaultChatMessageFontSize = 16;

  late AppPreferences _prefs;

  @override
  AppSettingsState build() {
    _prefs = ref.read(sharedPreferencesProvider);
    final stored = _prefs.getDouble(_chatMessageFontSizeKey);
    final fontSize = _snapChatMessageFontSize(
      (stored ?? defaultChatMessageFontSize).clamp(
        minChatMessageFontSize,
        maxChatMessageFontSize,
      ),
    );
    final language = AppLanguage.fromStorage(_prefs.getString(_languageKey));
    final showAllTab = _prefs.getBool(_showAllTabKey) ?? true;
    final colorThemeOverrides = _readColorThemeOverrides();
    return (
      fontSize: fontSize,
      language: language,
      showAllTab: showAllTab,
      colorThemeOverrides: colorThemeOverrides,
    );
  }

  void setChatMessageFontSize(double value) {
    final next = _snapChatMessageFontSize(
      value.clamp(minChatMessageFontSize, maxChatMessageFontSize),
    );
    if (next == state.fontSize) return;
    state = (
      fontSize: next,
      language: state.language,
      showAllTab: state.showAllTab,
      colorThemeOverrides: state.colorThemeOverrides,
    );
    _prefs.setDouble(_chatMessageFontSizeKey, next);
  }

  void setLanguage(AppLanguage language) {
    if (language == state.language) return;
    state = (
      fontSize: state.fontSize,
      language: language,
      showAllTab: state.showAllTab,
      colorThemeOverrides: state.colorThemeOverrides,
    );
    _prefs.setString(_languageKey, language.storageValue);
  }

  void setShowAllTab(bool value) {
    if (value == state.showAllTab) return;
    state = (
      fontSize: state.fontSize,
      language: state.language,
      showAllTab: value,
      colorThemeOverrides: state.colorThemeOverrides,
    );
    _prefs.setBool(_showAllTabKey, value);
  }

  void setUnreadBadgeColor(Color color) {
    final next = state.colorThemeOverrides.copyWith(
      unreadBadge: color.withValues(alpha: 1),
    );
    if (next == state.colorThemeOverrides) return;
    _setColorThemeOverrides(next);
  }

  void resetUnreadBadgeColor() {
    final next = state.colorThemeOverrides.copyWith(unreadBadge: null);
    if (next == state.colorThemeOverrides) return;
    _setColorThemeOverrides(next);
  }

  AppColorThemeOverrides _readColorThemeOverrides() {
    final raw = _prefs.getString(_colorThemeOverridesKey);
    if (raw == null || raw.isEmpty) return const AppColorThemeOverrides();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        return const AppColorThemeOverrides();
      }
      return AppColorThemeOverrides(
        unreadBadge: _colorFromArgb(decoded['unreadBadge']),
      );
    } on FormatException {
      return const AppColorThemeOverrides();
    } on TypeError {
      return const AppColorThemeOverrides();
    }
  }

  void _setColorThemeOverrides(AppColorThemeOverrides overrides) {
    state = (
      fontSize: state.fontSize,
      language: state.language,
      showAllTab: state.showAllTab,
      colorThemeOverrides: overrides,
    );
    if (overrides.isEmpty) {
      _prefs.remove(_colorThemeOverridesKey);
      return;
    }
    _prefs.setString(_colorThemeOverridesKey, jsonEncode(_toJson(overrides)));
  }

  static Color? _colorFromArgb(Object? value) {
    if (value is! int) return null;
    if (value < 0 || value > 0xFFFFFFFF) return null;
    return Color(value);
  }

  static Map<String, Object?> _toJson(AppColorThemeOverrides overrides) {
    return {
      if (overrides.unreadBadge != null)
        'unreadBadge': overrides.unreadBadge!.toARGB32(),
    };
  }

  static double _snapChatMessageFontSize(double value) {
    if (chatMessageFontSizeSteps <= 1) return value;
    final step =
        (maxChatMessageFontSize - minChatMessageFontSize) /
        (chatMessageFontSizeSteps - 1);
    final idx = ((value - minChatMessageFontSize) / step).round();
    final clampedIdx = idx.clamp(0, chatMessageFontSizeSteps - 1);
    return minChatMessageFontSize + step * clampedIdx;
  }
}

final appSettingsProvider =
    NotifierProvider<AppSettingsNotifier, AppSettingsState>(
      AppSettingsNotifier.new,
    );
