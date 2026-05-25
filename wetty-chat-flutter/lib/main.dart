import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'core/network/api_config.dart';
import 'core/network/app_version.dart';
import 'core/preferences/app_preferences.dart';
import 'core/providers/shared_preferences_provider.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final preferences = await loadMigratedAppPreferences();
  await AppVersionHeader.initialize();

  debugPrint('[APP] API_BASE_URL=$apiBaseUrl');

  runApp(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(preferences)],
      child: const WettyChatApp(),
    ),
  );
}
