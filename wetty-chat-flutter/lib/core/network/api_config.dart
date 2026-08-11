const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://chahui.app/_api',
);

Map<String, String> legacyApiAuthHeadersForUser(int userId) {
  return <String, String>{
    'X-User-Id': userId.toString(),
    'X-Client-Id': userId.toString(),
  };
}

Map<String, String> apiJsonHeaders([
  Map<String, String> authHeaders = const <String, String>{},
]) {
  return <String, String>{
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...authHeaders,
  };
}

/// Thin bridge for presentation-layer code that cannot access Riverpod ref
/// (e.g., image loading headers in deeply nested widgets).
/// Kept in sync with the auth session provider via the app widget.
class ApiSession {
  const ApiSession._();

  static int _currentUserId = 1;
  static Map<String, String> _authHeaders = const <String, String>{};

  static int get currentUserId => _currentUserId;
  static Map<String, String> get authHeaders => _authHeaders;

  static void updateSession({
    required int userId,
    required Map<String, String> authHeaders,
  }) {
    _currentUserId = userId;
    _authHeaders = Map<String, String>.unmodifiable(authHeaders);
  }
}
