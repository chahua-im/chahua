import 'dart:collection';

import 'package:chahua/core/api/models/saved_messages_api_models.dart';
import 'package:chahua/core/api/services/saved_messages_api_service.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/saved_messages/presentation/saved_messages_page.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  testWidgets('renders empty saved messages state', (tester) async {
    final api = _FakeSavedMessagesApiService(
      responses: const [ListSavedMessagesResponseDto()],
    );
    final router = _router();
    final container = _container(api);
    addTearDown(container.dispose);

    await _pump(tester, container, router);

    expect(find.text('No saved messages'), findsOneWidget);
  });

  testWidgets('renders rows without open buttons and pagination', (
    tester,
  ) async {
    final api = _FakeSavedMessagesApiService(
      responses: [
        ListSavedMessagesResponseDto(
          savedMessages: [
            _savedMessage(1, canLocateContext: false),
            _savedMessage(2, message: 'second saved message'),
          ],
          nextCursor: 2,
        ),
        ListSavedMessagesResponseDto(
          savedMessages: [_savedMessage(3, message: 'third saved message')],
        ),
      ],
    );
    final router = _router();
    final container = _container(api);
    addTearDown(container.dispose);

    await _pump(tester, container, router);

    expect(find.text('Alice'), findsWidgets);
    expect(find.text('General'), findsWidgets);
    expect(find.text('message 1'), findsOneWidget);
    expect(find.text('Open Original'), findsNothing);
    expect(find.text('Original unavailable'), findsNothing);

    await tester.tap(find.text('message 1'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Saved Messages'), findsOneWidget);
    expect(find.text('chat 42 launch 101'), findsNothing);

    await tester.tap(find.text('Load More'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('third saved message'), findsOneWidget);
    expect(api.globalRequests, [
      const _ListRequest(limit: 25, before: null),
      const _ListRequest(limit: 25, before: 2),
    ]);
  });

  testWidgets('opens top-level saved messages with LaunchRequest.message', (
    tester,
  ) async {
    final api = _FakeSavedMessagesApiService(
      responses: [
        ListSavedMessagesResponseDto(savedMessages: [_savedMessage(4)]),
      ],
    );
    final router = _router();
    final container = _container(api);
    addTearDown(container.dispose);

    await _pump(tester, container, router);
    expect(find.text('Open Original'), findsNothing);

    await tester.tap(find.text('message 4'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('chat 42 launch 104 back true'), findsOneWidget);

    router.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Saved Messages'), findsOneWidget);
    expect(find.text('message 4'), findsOneWidget);
  });

  testWidgets('bookmark tap opens unsave confirmation without navigating', (
    tester,
  ) async {
    final api = _FakeSavedMessagesApiService(
      responses: [
        ListSavedMessagesResponseDto(savedMessages: [_savedMessage(6)]),
      ],
    );
    final router = _router();
    final container = _container(api);
    addTearDown(container.dispose);

    await _pump(tester, container, router);

    await tester.tap(find.byIcon(CupertinoIcons.bookmark_fill));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Unsave message?'), findsOneWidget);
    expect(find.text('chat 42 launch 106 back true'), findsNothing);
  });

  testWidgets('opens thread saved messages with LaunchRequest.message', (
    tester,
  ) async {
    final api = _FakeSavedMessagesApiService(
      responses: [
        ListSavedMessagesResponseDto(
          savedMessages: [_savedMessage(5, threadRootId: 99)],
        ),
      ],
    );
    final router = _router();
    final container = _container(api);
    addTearDown(container.dispose);

    await _pump(tester, container, router);
    expect(find.text('Open Original'), findsNothing);

    await tester.tap(find.text('message 5'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('thread 99 launch 105 back true'), findsOneWidget);

    router.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Saved Messages'), findsOneWidget);
    expect(find.text('message 5'), findsOneWidget);
  });
}

ProviderContainer _container(_FakeSavedMessagesApiService api) {
  return ProviderContainer(
    overrides: [savedMessagesApiServiceProvider.overrideWithValue(api)],
  );
}

GoRouter _router() {
  return GoRouter(
    initialLocation: '/settings/saved-messages',
    routes: [
      GoRoute(
        path: '/settings/saved-messages',
        builder: (context, state) => const SavedMessagesPage(),
      ),
      GoRoute(
        path: '/saved-message/chat/:chatId',
        builder: (context, state) {
          final launchRequest = _launchRequest(state);
          return CupertinoPageScaffold(
            child: Center(
              child: Text(
                'chat ${state.pathParameters['chatId']} launch '
                '${_messageId(launchRequest)} back true',
              ),
            ),
          );
        },
        routes: [
          GoRoute(
            path: 'thread/:threadId',
            builder: (context, state) {
              final launchRequest = _launchRequest(state);
              return CupertinoPageScaffold(
                child: Center(
                  child: Text(
                    'thread ${state.pathParameters['threadId']} launch '
                    '${_messageId(launchRequest)} back true',
                  ),
                ),
              );
            },
          ),
        ],
      ),
      GoRoute(
        path: '/chat/:chatId',
        builder: (context, state) {
          final launchRequest = _launchRequest(state);
          return CupertinoPageScaffold(
            child: Center(
              child: Text(
                'shell chat ${state.pathParameters['chatId']} launch '
                '${_messageId(launchRequest)} back ${_showBackButton(state)}',
              ),
            ),
          );
        },
        routes: [
          GoRoute(
            path: 'thread/:threadId',
            builder: (context, state) {
              final launchRequest = _launchRequest(state);
              return CupertinoPageScaffold(
                child: Center(
                  child: Text(
                    'shell thread ${state.pathParameters['threadId']} launch '
                    '${_messageId(launchRequest)} back '
                    '${_showBackButton(state)}',
                  ),
                ),
              );
            },
          ),
        ],
      ),
    ],
  );
}

Future<void> _pump(
  WidgetTester tester,
  ProviderContainer container,
  GoRouter router,
) async {
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
}

LaunchRequest? _launchRequest(GoRouterState state) {
  final extra = state.extra;
  if (extra is Map<String, dynamic>) {
    return extra['launchRequest'] as LaunchRequest?;
  }
  return null;
}

int? _messageId(LaunchRequest? launchRequest) {
  return switch (launchRequest) {
    MessageLaunchRequest(:final messageId) => messageId,
    _ => null,
  };
}

bool _showBackButton(GoRouterState state) {
  final extra = state.extra;
  if (extra is Map<String, dynamic>) {
    return extra['showBackButton'] == true;
  }
  return false;
}

SavedMessageResponseDto _savedMessage(
  int id, {
  String? message,
  int? threadRootId,
  bool canLocateContext = true,
}) {
  return SavedMessageResponseDto(
    id: id,
    originalChatId: 42,
    originalThreadRootId: threadRootId,
    originalMessageId: 100 + id,
    originalSenderUid: 7,
    originalCreatedAt: DateTime.utc(2026, 1, id, 12),
    savedAt: DateTime.utc(2026, 2, id),
    message: message ?? 'message $id',
    messageType: 'text',
    sender: const SavedSenderSnapshotDto(uid: 7, name: 'Alice', gender: 0),
    chat: const SavedChatSnapshotDto(id: 42, name: 'General'),
    canLocateContext: canLocateContext,
  );
}

final class _ListRequest {
  const _ListRequest({required this.limit, required this.before});

  final int limit;
  final int? before;

  @override
  bool operator ==(Object other) {
    return other is _ListRequest &&
        other.limit == limit &&
        other.before == before;
  }

  @override
  int get hashCode => Object.hash(limit, before);

  @override
  String toString() => '_ListRequest(limit: $limit, before: $before)';
}

class _FakeSavedMessagesApiService extends SavedMessagesApiService {
  _FakeSavedMessagesApiService({
    List<ListSavedMessagesResponseDto> responses = const [],
  }) : _responses = Queue.of(responses),
       super(Dio());

  final Queue<ListSavedMessagesResponseDto> _responses;
  final List<_ListRequest> globalRequests = [];

  @override
  Future<ListSavedMessagesResponseDto> listSavedMessages({
    int limit = 25,
    int? before,
  }) {
    globalRequests.add(_ListRequest(limit: limit, before: before));
    if (_responses.isEmpty) {
      return Future.value(const ListSavedMessagesResponseDto());
    }
    return Future.value(_responses.removeFirst());
  }
}
