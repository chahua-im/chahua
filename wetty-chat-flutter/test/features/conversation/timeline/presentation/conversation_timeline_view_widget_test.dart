import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view_model.dart';
import 'package:chahua/features/shared/data/read_state_repository.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('ConversationTimelineView live edge behavior', () {
    testWidgets(
      'keeps latest message visible when latest row gains reactions at live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);

        _expectRowBottomPinnedToViewport(tester, 20);

        _updateMessage(
          container,
          _message(20, reactionCount: 12, text: 'message 20 with reactions'),
        );
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      'keeps latest message visible when live-edge viewport shrinks',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);

        _expectRowBottomPinnedToViewport(tester, 20);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      'keeps latest message visible when viewport shrink and reaction mutation combine',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);

        _expectRowBottomPinnedToViewport(tester, 20);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        _updateMessage(
          container,
          _message(20, reactionCount: 12, text: 'message 20 with reactions'),
        );
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets('allows the user to scroll away from live edge', (
      tester,
    ) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);

      await tester.drag(find.byType(CustomScrollView), const Offset(0, 16));
      await tester.pump();
      await tester.pump();
      await tester.drag(find.byType(CustomScrollView), const Offset(0, 16));
      await tester.pump();
      await tester.pump();

      _expectRowBottomBelowViewport(tester, 20);
    });

    testWidgets(
      'jump to message from sticky live edge reveals the target row',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await container
            .read(conversationTimelineViewModelProvider(_identity).notifier)
            .jumpToMessageServerId(6);
        await tester.pumpAndSettle();

        _expectRowVisibleInViewport(tester, 6);
        _expectRowBelowViewport(tester, 20);
      },
    );

    testWidgets(
      'far jump loads a historical segment and reveals the target row',
      (tester) async {
        final api = _FakeMessageApiService(
          _messages(81, 100),
          aroundResponses: {
            40: _response(
              messages: _messages(36, 60),
              nextCursor: '35',
              prevCursor: '61',
            ),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 100);
        expect(_rowFinder(40), findsNothing);

        await container
            .read(conversationTimelineViewModelProvider(_identity).notifier)
            .jumpToMessageServerId(40);
        await tester.pumpAndSettle();

        expect(api.requests.any((request) => request.around == 40), isTrue);
        _expectRowVisibleInViewport(tester, 40);
        expect(_rowFinder(100), findsNothing);
      },
    );

    testWidgets(
      're-pins latest message when it mutates while viewport is near live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, 48));
        await tester.pump();
        expect(_rowFinder(20), findsOneWidget);

        _updateMessage(
          container,
          _message(20, reactionCount: 12, text: 'message 20 with reactions'),
        );
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      're-pins latest message when a row above it mutates while viewport is near live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await _moveSlightlyAwayFromLiveEdge(tester);

        _updateMessage(
          container,
          _message(19, reactionCount: 12, text: 'message 19 with reactions'),
        );
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      're-pins latest message when viewport shrinks while viewport is near live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await _moveSlightlyAwayFromLiveEdge(tester);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      're-pins latest message when near-live-edge viewport shrinks and latest row mutates',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await _moveSlightlyAwayFromLiveEdge(tester);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        _updateMessage(
          container,
          _message(20, reactionCount: 12, text: 'message 20 with reactions'),
        );
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets('pins newly appended message when viewport is near live edge', (
      tester,
    ) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);

      await _moveSlightlyAwayFromLiveEdge(tester);

      _appendMessage(container, _message(21));
      await tester.pump();
      await tester.pump();

      _expectRowBottomPinnedToViewport(tester, 21);
    });

    testWidgets(
      'pins newly appended message when near-live-edge viewport shrinks',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        await _moveSlightlyAwayFromLiveEdge(tester);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        _appendMessage(container, _message(21));
        await tester.pump();
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );
  });
}

const _identity = (chatId: 42, threadRootId: null);
const _viewportKey = ValueKey<String>('conversation-timeline-test-viewport');

Future<ProviderContainer> _container(_FakeMessageApiService api) async {
  SharedPreferences.setMockInitialValues({});
  final preferences = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(preferences),
      messageApiServiceV2Provider.overrideWithValue(api),
      readStateRepositoryProvider.overrideWith(_NoopReadStateRepository.new),
    ],
  );
}

Future<void> _pumpTimeline(
  WidgetTester tester, {
  required ProviderContainer container,
  required double viewportHeight,
}) async {
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: CupertinoPageScaffold(
          child: Center(
            child: SizedBox(
              key: _viewportKey,
              width: 390,
              height: viewportHeight,
              child: ConversationTimelineView(
                chatId: _identity.chatId,
                launchRequest: const LaunchRequest.latest(),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> _settleTimeline(WidgetTester tester) async {
  await tester.pump();
  await tester.pump();
}

void _updateMessage(ProviderContainer container, MessageItemDto dto) {
  container
      .read(conversationTimelineMessageStoreProvider.notifier)
      .updateMessage(_identity, ConversationMessageV2.fromMessageItemDto(dto));
}

void _appendMessage(ProviderContainer container, MessageItemDto dto) {
  container
      .read(conversationTimelineMessageStoreProvider.notifier)
      .newMessage(_identity, ConversationMessageV2.fromMessageItemDto(dto));
}

Future<void> _moveSlightlyAwayFromLiveEdge(WidgetTester tester) async {
  await tester.drag(find.byType(CustomScrollView), const Offset(0, 48));
  await tester.pump();
}

void _expectRowBottomPinnedToViewport(WidgetTester tester, int messageId) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(_rowFinder(messageId));
  expect(row.bottom, closeTo(viewport.bottom, 1));
  expect(row.top < viewport.bottom, isTrue);
}

void _expectRowBottomBelowViewport(WidgetTester tester, int messageId) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(_rowFinder(messageId));
  expect(row.bottom, greaterThan(viewport.bottom + 1));
  expect(row.top < viewport.bottom, isTrue);
}

void _expectRowBelowViewport(WidgetTester tester, int messageId) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(_rowFinder(messageId));
  expect(row.top, greaterThanOrEqualTo(viewport.bottom));
}

void _expectRowVisibleInViewport(WidgetTester tester, int messageId) {
  final finder = _rowFinder(messageId);
  expect(finder, findsOneWidget);
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(finder);
  expect(row.bottom, greaterThan(viewport.top));
  expect(row.top, lessThan(viewport.bottom));
}

Finder _rowFinder(int messageId) {
  return find.byWidgetPredicate(
    (widget) =>
        widget is MessageRowV2 && widget.message.serverMessageId == messageId,
    description: 'MessageRowV2 for server message $messageId',
    skipOffstage: false,
  );
}

List<MessageItemDto> _messages(int start, int end) {
  return [for (var id = start; id <= end; id++) _message(id)];
}

MessageItemDto _message(int id, {int reactionCount = 0, String? text}) {
  return MessageItemDto(
    id: id,
    message: text ?? 'message $id',
    sender: const UserDto(uid: 7, name: 'Sender'),
    chatId: _identity.chatId,
    clientGeneratedId: 'client-$id',
    reactions: [
      for (var i = 0; i < reactionCount; i++)
        ReactionSummaryDto(emoji: 'r$i', count: i + 1),
    ],
  );
}

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService(
    this.messages, {
    Map<int, ListMessagesResponseDto>? aroundResponses,
  }) : aroundResponses = aroundResponses ?? const {},
       super(Dio(), 7);

  final List<MessageItemDto> messages;
  final Map<int, ListMessagesResponseDto> aroundResponses;
  final requests = <({int? before, int? after, int? around, int? max})>[];

  @override
  Future<ListMessagesResponseDto> fetchConversationMessages(
    ConversationIdentity identity, {
    int? max,
    int? before,
    int? after,
    int? around,
  }) async {
    requests.add((before: before, after: after, around: around, max: max));
    final aroundResponse = aroundResponses[around];
    if (aroundResponse != null) {
      return aroundResponse;
    }
    return ListMessagesResponseDto(messages: messages);
  }

  @override
  Future<MarkChatReadStateResponseDto> markMessagesAsRead(
    String chatId,
    int messageId,
  ) async {
    return MarkChatReadStateResponseDto(
      lastReadMessageId: messageId.toString(),
    );
  }
}

class _NoopReadStateRepository extends ReadStateRepository {
  _NoopReadStateRepository(super.ref);

  @override
  void reportVisibleMessageRead({
    required ConversationIdentity identity,
    required int messageId,
  }) {}
}

ListMessagesResponseDto _response({
  required List<MessageItemDto> messages,
  String? nextCursor,
  String? prevCursor,
}) {
  return ListMessagesResponseDto(
    messages: messages,
    nextCursor: nextCursor,
    prevCursor: prevCursor,
  );
}
