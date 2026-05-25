import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    SharedPreferencesAsyncPlatform.instance = null;
  });

  Future<AppPreferences> loadWithData(Map<String, Object> data) async {
    SharedPreferencesAsyncPlatform.instance =
        InMemorySharedPreferencesAsync.withData(data);
    return AppPreferences.load(asyncPreferences: SharedPreferencesAsync());
  }

  test('loads app preference keys from SharedPreferencesAsync', () async {
    final preferences = await loadWithData(const <String, Object>{
      'app_language': 'english',
      'chat_message_font_size': 18.0,
      'unrelated_plugin_key': 'ignored',
    });

    expect(preferences.getString('app_language'), 'english');
    expect(preferences.getDouble('chat_message_font_size'), 18.0);
    expect(preferences.containsKey('unrelated_plugin_key'), isFalse);
  });

  test(
    'writes update both async storage and the synchronous snapshot',
    () async {
      final preferences = await loadWithData(const <String, Object>{});

      await preferences.setString('auth_session_jwt_token', 'token-1');

      final asyncPreferences = SharedPreferencesAsync();
      expect(preferences.getString('auth_session_jwt_token'), 'token-1');
      expect(
        await asyncPreferences.getString('auth_session_jwt_token'),
        'token-1',
      );
    },
  );

  test(
    'remove updates both async storage and the synchronous snapshot',
    () async {
      final preferences = await loadWithData(const <String, Object>{
        'auth_session_jwt_token': 'token-1',
      });

      await preferences.remove('auth_session_jwt_token');

      final asyncPreferences = SharedPreferencesAsync();
      expect(preferences.containsKey('auth_session_jwt_token'), isFalse);
      expect(
        await asyncPreferences.getString('auth_session_jwt_token'),
        isNull,
      );
    },
  );
}
