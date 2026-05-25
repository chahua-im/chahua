import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late ProviderContainer container;

  setUp(() async {
    final prefs = AppPreferences.withData(const <String, Object>{});
    container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        authBootstrapApiProvider.overrideWithValue(_FakeAuthBootstrapApi()),
      ],
    );
  });

  tearDown(() => container.dispose());

  test(
    'defaults to uid 1 while bootstrapping when no preference is stored',
    () {
      final session = container.read(authSessionProvider);
      expect(session.developerUserId, AuthSessionNotifier.defaultUserId);
      expect(session.currentUserId, AuthSessionNotifier.defaultUserId);
      expect(session.status, AuthBootstrapStatus.bootstrapping);
    },
  );

  test('persists the selected developer uid', () async {
    await container.read(authSessionProvider.notifier).setCurrentUserId(42);

    final session = container.read(authSessionProvider);
    expect(session.developerUserId, 42);
    expect(session.currentUserId, 42);
  });

  test('loginWithCredentials stores jwt session and current user id', () async {
    container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(
          AppPreferences.withData(const <String, Object>{}),
        ),
        authBootstrapApiProvider.overrideWithValue(
          _FakeAuthBootstrapApi(
            onLoginWithCredentials: ({required username, required password}) {
              expect(username, 'alice');
              expect(password, 'secret');
              return 'issued-token';
            },
            onFetchAuthToken: (headers) {
              expect(headers['Authorization'], 'Bearer issued-token');
              return 'server-token';
            },
            onFetchMe: (headers) {
              expect(headers['Authorization'], 'Bearer server-token');
              return const AuthBootstrapMe(7);
            },
          ),
        ),
      ],
    );

    await container
        .read(authSessionProvider.notifier)
        .loginWithCredentials('alice', 'secret');

    final session = container.read(authSessionProvider);
    expect(session.mode, AuthSessionMode.jwt);
    expect(session.currentUserId, 7);
    expect(session.jwtToken, 'server-token');
  });

  test(
    'bootstrap prefers developer UID auth over persisted jwt restore',
    () async {
      final prefs = AppPreferences.withData({
        'auth_session_jwt_token': 'persisted-token',
      });
      var jwtValidationAttempted = false;
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onFetchAuthToken: (headers) {
                expect(headers['X-User-Id'], '1');
                expect(headers['X-Client-Id'], '1');
                jwtValidationAttempted = headers.containsKey('Authorization');
                return 'dev-token';
              },
            ),
          ),
        ],
      );

      await container.read(authSessionProvider.notifier).bootstrap();

      final session = container.read(authSessionProvider);
      expect(session.mode, AuthSessionMode.devHeader);
      expect(session.status, AuthBootstrapStatus.authenticated);
      expect(session.currentUserId, AuthSessionNotifier.defaultUserId);
      expect(session.jwtToken, isNull);
      expect(jwtValidationAttempted, isFalse);
    },
  );

  test(
    'bootstrap restores persisted jwt after developer UID auth fails',
    () async {
      final prefs = AppPreferences.withData({
        'auth_session_jwt_token': 'persisted-token',
      });
      final requests = <String>[];
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onFetchAuthToken: (headers) {
                final authHeader = headers['Authorization'];
                if (authHeader != null) {
                  requests.add(authHeader);
                  expect(authHeader, 'Bearer persisted-token');
                  return 'server-token';
                }
                requests.add('dev:${headers['X-User-Id']}');
                return null;
              },
              onFetchMe: (headers) {
                requests.add('me:${headers['Authorization']}');
                expect(headers['Authorization'], 'Bearer server-token');
                return const AuthBootstrapMe(9);
              },
            ),
          ),
        ],
      );

      await container.read(authSessionProvider.notifier).bootstrap();

      final session = container.read(authSessionProvider);
      expect(session.mode, AuthSessionMode.jwt);
      expect(session.status, AuthBootstrapStatus.authenticated);
      expect(session.currentUserId, 9);
      expect(session.jwtToken, 'server-token');
      expect(requests, <String>[
        'dev:1',
        'Bearer persisted-token',
        'me:Bearer server-token',
      ]);
    },
  );

  test('bootstrap falls back to dev header mode when jwt is absent', () async {
    container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(
          AppPreferences.withData(const <String, Object>{}),
        ),
        authBootstrapApiProvider.overrideWithValue(
          _FakeAuthBootstrapApi(
            onFetchAuthToken: (headers) {
              expect(headers['X-User-Id'], '1');
              expect(headers['X-Client-Id'], '1');
              return 'dev-token';
            },
          ),
        ),
      ],
    );

    await container.read(authSessionProvider.notifier).bootstrap();

    final session = container.read(authSessionProvider);
    expect(session.mode, AuthSessionMode.devHeader);
    expect(session.status, AuthBootstrapStatus.authenticated);
    expect(session.currentUserId, AuthSessionNotifier.defaultUserId);
    expect(session.jwtToken, isNull);
  });

  test(
    'loginWithCredentials rejects empty fields before network call',
    () async {
      var loginAttempts = 0;
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(
            AppPreferences.withData(const <String, Object>{}),
          ),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onLoginWithCredentials: ({required username, required password}) {
                loginAttempts++;
                return null;
              },
            ),
          ),
        ],
      );

      await expectLater(
        container
            .read(authSessionProvider.notifier)
            .loginWithCredentials('', ''),
        throwsException,
      );
      expect(loginAttempts, 0);
    },
  );

  test(
    'loginWithCredentials treats non-200 credentials response as failure',
    () async {
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(
            AppPreferences.withData(const <String, Object>{}),
          ),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onLoginWithCredentials: ({required username, required password}) {
                return null;
              },
            ),
          ),
        ],
      );

      await expectLater(
        container
            .read(authSessionProvider.notifier)
            .loginWithCredentials('alice', 'wrong-password'),
        throwsException,
      );

      final session = container.read(authSessionProvider);
      expect(session.mode, AuthSessionMode.none);
      expect(session.jwtToken, isNull);
    },
  );

  test('loginWithCredentials treats empty token response as failure', () async {
    container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(
          AppPreferences.withData(const <String, Object>{}),
        ),
        authBootstrapApiProvider.overrideWithValue(
          _FakeAuthBootstrapApi(
            onLoginWithCredentials: ({required username, required password}) {
              return '';
            },
          ),
        ),
      ],
    );

    await expectLater(
      container
          .read(authSessionProvider.notifier)
          .loginWithCredentials('alice', 'secret'),
      throwsException,
    );
  });

  test(
    'credential login accepts non-empty plain body from non-200 response',
    () async {
      final dio = Dio()
        ..httpClientAdapter = _PlainResponseAdapter(401, 'token');
      final api = AuthBootstrapApi(dio);

      final token = await api.loginWithCredentials(
        username: 'alice',
        password: 'secret',
      );

      expect(token, 'token');
    },
  );

  test(
    'clearJwt re-runs bootstrap and becomes unauthenticated when dev probe fails',
    () async {
      final prefs = AppPreferences.withData({
        'auth_session_jwt_token': 'persisted-token',
      });
      final requests = <Uri>[];
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onFetchAuthToken: (headers) {
                requests.add(Uri(path: '/users/auth-token'));
                return null;
              },
            ),
          ),
        ],
      );

      await container.read(authSessionProvider.notifier).clearJwt();

      final session = container.read(authSessionProvider);
      expect(session.status, AuthBootstrapStatus.unauthenticated);
      expect(session.mode, AuthSessionMode.none);
      expect(session.jwtToken, isNull);
      expect(
        requests.where((uri) => uri.path.endsWith('/users/auth-token')).length,
        1,
      );
    },
  );

  test(
    'bootstrap preserves stored jwt when verification request fails',
    () async {
      final prefs = AppPreferences.withData({
        'auth_session_jwt_token': 'persisted-token',
      });
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onFetchAuthToken: (headers) => throw DioException(
                requestOptions: RequestOptions(path: '/users/auth-token'),
              ),
            ),
          ),
        ],
      );

      await container.read(authSessionProvider.notifier).bootstrap();

      final session = container.read(authSessionProvider);
      expect(session.status, AuthBootstrapStatus.bootstrapping);
      expect(session.mode, AuthSessionMode.none);
      expect(prefs.getString('auth_session_jwt_token'), 'persisted-token');
    },
  );

  test(
    'bootstrap can run again after a previous bootstrap completed',
    () async {
      var devProbeCount = 0;
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(
            AppPreferences.withData(const <String, Object>{}),
          ),
          authBootstrapApiProvider.overrideWithValue(
            _FakeAuthBootstrapApi(
              onFetchAuthToken: (headers) {
                devProbeCount++;
                return null;
              },
            ),
          ),
        ],
      );

      await container.read(authSessionProvider.notifier).bootstrap();
      await container.read(authSessionProvider.notifier).bootstrap();

      expect(devProbeCount, 2);
    },
  );
}

class _PlainResponseAdapter implements HttpClientAdapter {
  const _PlainResponseAdapter(this.statusCode, this.body);

  final int statusCode;
  final String body;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    return ResponseBody.fromString(
      body,
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.textPlainContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

class _FakeAuthBootstrapApi extends AuthBootstrapApi {
  _FakeAuthBootstrapApi({
    this.onFetchAuthToken,
    this.onFetchMe,
    this.onLoginWithCredentials,
  }) : super(_noopDio);

  final String? Function(Map<String, String> headers)? onFetchAuthToken;
  final AuthBootstrapMe? Function(Map<String, String> headers)? onFetchMe;
  final String? Function({required String username, required String password})?
  onLoginWithCredentials;

  static final Dio _noopDio = Dio();

  @override
  Future<String?> fetchAuthToken(Map<String, String> authHeaders) async {
    return onFetchAuthToken?.call(authHeaders);
  }

  @override
  Future<AuthBootstrapMe?> fetchMe(Map<String, String> authHeaders) async {
    return onFetchMe?.call(authHeaders);
  }

  @override
  Future<String?> loginWithCredentials({
    required String username,
    required String password,
  }) async {
    return onLoginWithCredentials?.call(username: username, password: password);
  }
}
