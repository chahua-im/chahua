import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences/util/legacy_to_async_migration_util.dart';

const String appPreferencesMigrationCompletedKey =
    'app_preferences_async_migration_completed';

const Set<String> appPreferenceKeys = {
  'app_language',
  'appearance_color_theme_overrides',
  'auth_session_jwt_token',
  'chat_list_show_all_tab',
  'chat_message_font_size',
  'dev_session_user_id',
  'push_apns_device_token',
  'push_fcm_device_token',
  'push_unsupported_device_token',
  'sticker_auto_sort_enabled',
  'sticker_pack_order',
};

Future<AppPreferences> loadMigratedAppPreferences() async {
  const options = SharedPreferencesOptions();
  final legacyPreferences = await SharedPreferences.getInstance();
  await migrateLegacySharedPreferencesToSharedPreferencesAsyncIfNecessary(
    legacySharedPreferencesInstance: legacyPreferences,
    sharedPreferencesAsyncOptions: options,
    migrationCompletedKey: appPreferencesMigrationCompletedKey,
  );
  return AppPreferences.load(
    asyncPreferences: SharedPreferencesAsync(options: options),
  );
}

class AppPreferences {
  AppPreferences._({
    required SharedPreferencesAsync? asyncPreferences,
    required Map<String, Object?> values,
  }) : _asyncPreferences = asyncPreferences,
       _values = Map<String, Object?>.from(values);

  final SharedPreferencesAsync? _asyncPreferences;
  final Map<String, Object?> _values;

  static Future<AppPreferences> load({
    SharedPreferencesAsync? asyncPreferences,
    Set<String> allowList = appPreferenceKeys,
  }) async {
    final preferences = asyncPreferences ?? SharedPreferencesAsync();
    final values = await preferences.getAll(allowList: allowList);
    return AppPreferences._(asyncPreferences: preferences, values: values);
  }

  @visibleForTesting
  factory AppPreferences.withData(Map<String, Object?> values) {
    return AppPreferences._(asyncPreferences: null, values: values);
  }

  bool containsKey(String key) => _values.containsKey(key);

  String? getString(String key) => _values[key] as String?;

  bool? getBool(String key) => _values[key] as bool?;

  int? getInt(String key) => _values[key] as int?;

  double? getDouble(String key) => _values[key] as double?;

  List<String>? getStringList(String key) {
    final value = _values[key];
    if (value is! List<Object?>) return null;
    return value.cast<String>();
  }

  Future<void> setString(String key, String value) {
    _values[key] = value;
    return _asyncPreferences?.setString(key, value) ?? Future<void>.value();
  }

  Future<void> setBool(String key, bool value) {
    _values[key] = value;
    return _asyncPreferences?.setBool(key, value) ?? Future<void>.value();
  }

  Future<void> setInt(String key, int value) {
    _values[key] = value;
    return _asyncPreferences?.setInt(key, value) ?? Future<void>.value();
  }

  Future<void> setDouble(String key, double value) {
    _values[key] = value;
    return _asyncPreferences?.setDouble(key, value) ?? Future<void>.value();
  }

  Future<void> setStringList(String key, List<String> value) {
    _values[key] = List<String>.of(value);
    return _asyncPreferences?.setStringList(key, value) ?? Future<void>.value();
  }

  Future<void> remove(String key) {
    _values.remove(key);
    return _asyncPreferences?.remove(key) ?? Future<void>.value();
  }
}
