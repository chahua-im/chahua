import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/dio_client.dart';
import '../network/api_config.dart';
import '../preferences/app_preferences.dart';
import '../providers/shared_preferences_provider.dart';

const String _credentialLoginUrl =
    'https://www.shireyishunjian.com/main/shireyishunjian-telegram-api/chahua_login.php';

enum AuthBootstrapStatus { bootstrapping, authenticated, unauthenticated }

enum AuthSessionMode { none, devHeader, jwt }

class AuthSessionState {
  const AuthSessionState({
    required this.status,
    required this.mode,
    required this.developerUserId,
    required this.currentUserId,
    this.jwtToken,
  });

  final AuthBootstrapStatus status;
  final AuthSessionMode mode;
  final int developerUserId;
  final int currentUserId;
  final String? jwtToken;

  bool get isBootstrapping => status == AuthBootstrapStatus.bootstrapping;
  bool get isAuthenticated => status == AuthBootstrapStatus.authenticated;
  bool get hasJwtToken => jwtToken != null && jwtToken!.isNotEmpty;

  Map<String, String> get authHeaders {
    return switch (mode) {
      AuthSessionMode.devHeader => legacyApiAuthHeadersForUser(currentUserId),
      AuthSessionMode.jwt when hasJwtToken => <String, String>{
        'Authorization': 'Bearer $jwtToken',
      },
      _ => const <String, String>{},
    };
  }

  AuthSessionState copyWith({
    AuthBootstrapStatus? status,
    AuthSessionMode? mode,
    int? developerUserId,
    int? currentUserId,
    String? jwtToken,
    bool clearJwtToken = false,
  }) {
    return AuthSessionState(
      status: status ?? this.status,
      mode: mode ?? this.mode,
      developerUserId: developerUserId ?? this.developerUserId,
      currentUserId: currentUserId ?? this.currentUserId,
      jwtToken: clearJwtToken ? null : (jwtToken ?? this.jwtToken),
    );
  }
}

class AuthSessionNotifier extends Notifier<AuthSessionState> {
  static const int defaultUserId = 1;
  static const String _userIdStorageKey = 'dev_session_user_id';
  static const String _jwtTokenStorageKey = 'auth_session_jwt_token';

  late AppPreferences _prefs;
  late AuthBootstrapApi _authApi;

  Future<void>? _bootstrapFuture;

  @override
  AuthSessionState build() {
    _prefs = ref.read(sharedPreferencesProvider);
    _authApi = ref.read(authBootstrapApiProvider);
    final developerUserId = _prefs.getInt(_userIdStorageKey) ?? defaultUserId;
    final jwtToken = _prefs.getString(_jwtTokenStorageKey);
    return AuthSessionState(
      status: AuthBootstrapStatus.bootstrapping,
      mode: AuthSessionMode.none,
      developerUserId: developerUserId,
      currentUserId: developerUserId,
      jwtToken: jwtToken,
    );
  }

  Future<void> bootstrap() {
    final pending = _bootstrapFuture;
    if (pending != null) {
      return pending;
    }

    final future = _runBootstrap();
    late final Future<void> trackedFuture;
    trackedFuture = future.whenComplete(() {
      if (identical(_bootstrapFuture, trackedFuture)) {
        _bootstrapFuture = null;
      }
    });
    _bootstrapFuture = trackedFuture;
    return trackedFuture;
  }

  Future<void> _runBootstrap() async {
    state = state.copyWith(status: AuthBootstrapStatus.bootstrapping);

    final developerUserId = _prefs.getInt(_userIdStorageKey) ?? defaultUserId;

    try {
      final devHeaders = legacyApiAuthHeadersForUser(developerUserId);
      final devToken = await _fetchAuthToken(devHeaders);
      if (devToken != null) {
        state = AuthSessionState(
          status: AuthBootstrapStatus.authenticated,
          mode: AuthSessionMode.devHeader,
          developerUserId: developerUserId,
          currentUserId: developerUserId,
          jwtToken: null,
        );
        return;
      }

      final persistedToken = _prefs.getString(_jwtTokenStorageKey);
      if (persistedToken != null && persistedToken.trim().isNotEmpty) {
        final normalizedToken = await _validateJwtToken(persistedToken);
        if (normalizedToken != null) {
          final me = await _fetchMe(<String, String>{
            'Authorization': 'Bearer $normalizedToken',
          });
          if (me != null) {
            await _prefs.setString(_jwtTokenStorageKey, normalizedToken);
            state = AuthSessionState(
              status: AuthBootstrapStatus.authenticated,
              mode: AuthSessionMode.jwt,
              developerUserId: developerUserId,
              currentUserId: me.uid,
              jwtToken: normalizedToken,
            );
            return;
          }
        }
        await _prefs.remove(_jwtTokenStorageKey);
      }
    } catch (error, stackTrace) {
      debugPrint('[auth:bootstrap] exception during bootstrap: $error');
      debugPrintStack(label: '[auth:bootstrap] stack', stackTrace: stackTrace);
      return;
    }

    state = AuthSessionState(
      status: AuthBootstrapStatus.unauthenticated,
      mode: AuthSessionMode.none,
      developerUserId: developerUserId,
      currentUserId: developerUserId,
      jwtToken: null,
    );
  }

  Future<void> loginWithJwt(String token) async {
    final normalizedInput = token.trim();
    if (normalizedInput.isEmpty) {
      throw Exception('Enter a JWT token.');
    }

    await _completeJwtLogin(normalizedInput);
  }

  Future<void> loginWithCredentials(String username, String password) async {
    final normalizedUsername = username.trim();
    if (normalizedUsername.isEmpty || password.isEmpty) {
      throw Exception('Enter username and password.');
    }

    final jwtToken = await _authApi.loginWithCredentials(
      username: normalizedUsername,
      password: password,
    );
    if (jwtToken == null) {
      throw Exception('Incorrect username or password.');
    }

    await _completeJwtLogin(jwtToken);
  }

  Future<void> _completeJwtLogin(String token) async {
    final normalizedToken = await _validateJwtToken(token.trim());
    if (normalizedToken == null) {
      throw Exception('Invalid JWT token.');
    }

    final me = await _fetchMe(<String, String>{
      'Authorization': 'Bearer $normalizedToken',
    });
    if (me == null) {
      throw Exception('Failed to load the authenticated user.');
    }

    await _prefs.setString(_jwtTokenStorageKey, normalizedToken);
    state = AuthSessionState(
      status: AuthBootstrapStatus.authenticated,
      mode: AuthSessionMode.jwt,
      developerUserId: state.developerUserId,
      currentUserId: me.uid,
      jwtToken: normalizedToken,
    );
  }

  Future<void> setCurrentUserId(int userId) async {
    await _prefs.setInt(_userIdStorageKey, userId);
    if (state.developerUserId == userId && state.mode == AuthSessionMode.jwt) {
      return;
    }

    if (state.mode == AuthSessionMode.jwt) {
      state = state.copyWith(developerUserId: userId);
      return;
    }

    state = state.copyWith(developerUserId: userId, currentUserId: userId);
  }

  Future<void> clearJwt() async {
    debugPrint('[auth:clear-jwt] clearing stored jwt and re-running bootstrap');
    // Push unsubscribe is handled reactively in app.dart via the auth listener,
    // which fires when the state transitions away from authenticated.
    await _prefs.remove(_jwtTokenStorageKey);
    state = AuthSessionState(
      status: AuthBootstrapStatus.bootstrapping,
      mode: AuthSessionMode.none,
      developerUserId: state.developerUserId,
      currentUserId: state.developerUserId,
      jwtToken: null,
    );
    await bootstrap();
    debugPrint(
      '[auth:clear-jwt] completed with status=${state.status} mode=${state.mode}',
    );
  }

  Future<void> resetToDefault() async {
    await _prefs.remove(_userIdStorageKey);
    await setCurrentUserId(defaultUserId);
  }

  Future<String?> _validateJwtToken(String token) async {
    return _fetchAuthToken(<String, String>{'Authorization': 'Bearer $token'});
  }

  Future<String?> _fetchAuthToken(Map<String, String> authHeaders) async {
    return _authApi.fetchAuthToken(authHeaders);
  }

  Future<_MeResponse?> _fetchMe(Map<String, String> authHeaders) async {
    final me = await _authApi.fetchMe(authHeaders);
    return me == null ? null : _MeResponse(me.uid);
  }
}

class AuthBootstrapMe {
  const AuthBootstrapMe(this.uid);

  final int uid;
}

class AuthBootstrapApi {
  const AuthBootstrapApi(this._dio);

  final Dio _dio;

  Future<String?> fetchAuthToken(Map<String, String> authHeaders) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/users/auth-token',
        options: Options(headers: authHeaders),
      );
      final token = response.data?['token'];
      if (token is! String || token.trim().isEmpty) {
        return null;
      }
      return token.trim();
    } on DioException catch (error) {
      if (!_isUnauthorized(error)) {
        rethrow;
      }
      return null;
    }
  }

  Future<AuthBootstrapMe?> fetchMe(Map<String, String> authHeaders) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/users/me',
        options: Options(headers: authHeaders),
      );
      final uid = response.data?['uid'];
      if (uid is! int || uid <= 0) {
        return null;
      }
      return AuthBootstrapMe(uid);
    } on DioException catch (error) {
      if (!_isUnauthorized(error)) {
        rethrow;
      }
      return null;
    }
  }

  Future<String?> loginWithCredentials({
    required String username,
    required String password,
  }) async {
    final encodedBody =
        'username=${Uri.encodeQueryComponent(username)}'
        '&password=${Uri.encodeQueryComponent(password)}';
    try {
      final response = await _dio.post<String>(
        _credentialLoginUrl,
        data: encodedBody,
        options: Options(
          contentType: Headers.formUrlEncodedContentType,
          responseType: ResponseType.plain,
          headers: <String, String>{'Accept': 'text/plain'},
        ),
      );
      final token = _nonEmptyPlainBody(response.data);
      if (token == null) {
        return null;
      }
      return token;
    } on DioException catch (error) {
      return _nonEmptyPlainBody(error.response?.data);
    }
  }
}

String? _nonEmptyPlainBody(Object? data) {
  if (data is! String) {
    return null;
  }
  final body = data.trim();
  return body.isEmpty ? null : body;
}

bool _isUnauthorized(DioException error) => error.response?.statusCode == 401;

class _MeResponse {
  const _MeResponse(this.uid);

  final int uid;
}

final authSessionProvider =
    NotifierProvider<AuthSessionNotifier, AuthSessionState>(
      AuthSessionNotifier.new,
    );

final authBootstrapDioProvider = Provider<Dio>((ref) {
  final dio = Dio(
    BaseOptions(
      baseUrl: apiBaseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 15),
      headers: <String, String>{
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    ),
  );

  if (kDebugMode) {
    dio.interceptors.add(DebugLogInterceptor());
  }

  ref.onDispose(dio.close);
  return dio;
});

final authBootstrapApiProvider = Provider<AuthBootstrapApi>((ref) {
  final dio = ref.read(authBootstrapDioProvider);
  return AuthBootstrapApi(dio);
});

final devSessionProvider = Provider<int>((ref) {
  return ref.watch(authSessionProvider).currentUserId;
});

final authHeadersProvider = Provider<Map<String, String>>((ref) {
  final session = ref.watch(authSessionProvider);
  return apiJsonHeaders(session.authHeaders);
});
