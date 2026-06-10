import 'dart:async';

import 'package:chahua/core/api/models/chats_api_models.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/network/api_config.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/conversation/compose/data/message_api_service_v2.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_compose_v2.dart';
import 'package:chahua/features/conversation/message_bubble/presentation/message_row_v2.dart';
import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/data/conversation_outbound_message_queue.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/timeline/model/conversation_message_highlight.dart';
import 'package:chahua/features/conversation/shared/presentation/conversation_surface_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view_model.dart';
import 'package:chahua/features/conversation/timeline/presentation/jump_to_latest_fab.dart';
import 'package:chahua/features/shared/data/read_state_repository.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:chahua/core/preferences/app_preferences.dart';

void main() {
  group('ConversationTimelineView live edge behavior', () {
    // Use case:
    // A brand-new group has no messages yet. Opening the latest timeline should
    // complete bootstrap and show a blank timeline instead of a permanent
    // loading spinner.
    testWidgets('hides loading spinner when latest conversation is empty', (
      tester,
    ) async {
      final api = _FakeMessageApiService(const []);
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);

      expect(find.byType(CupertinoActivityIndicator), findsNothing);
    });

    // Use case:
    // The user is at the live edge and the latest message receives reactions.
    // The row grows taller, but the latest message should remain pinned to the
    // bottom instead of being pushed partly off-screen.
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

    // Use case:
    // The user is at the live edge and the visible viewport shrinks, such as
    // when the keyboard opens. The current latest message should remain visible
    // at the bottom after layout settles.
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

    // Use case:
    // Keyboard resize and a latest-message mutation can happen in the same UI
    // turn. The live-edge correction should handle both size changes together
    // and keep the latest row pinned.
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

    // Use case:
    // A user who intentionally drags away from the live edge should be allowed
    // to browse history. The timeline must not behave as permanently sticky to
    // the bottom after live-edge follow has been enabled.
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

    // Use case:
    // The user is currently sticky at latest, then taps a search result, pin, or
    // other jump target inside the loaded segment. The jump must reveal the
    // target row instead of live-edge settling back to the tail.
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

    // Use case:
    // A jump target is outside the currently loaded latest window. The timeline
    // should fetch an around-window for that historical message and display the
    // target rather than keeping the latest segment on screen.
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

    // Use case:
    // Backend around pagination can include all newer rows while returning
    // prevCursor=null. In that state Flutter should know no newer request is
    // needed, but the already-loaded tail must still be reachable by scrolling.
    testWidgets(
      'around response with no newer page still lets user reach loaded tail',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            40: _response(
              messages: _messages(36, 60),
              nextCursor: '35',
              prevCursor: null,
            ),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: const LaunchRequest.message(
            messageId: 40,
            highlight: false,
          ),
        );
        await tester.pumpAndSettle();

        expect(api.requests.any((request) => request.around == 40), isTrue);
        _expectRowVisibleInViewport(tester, 40);

        final state = container.read(
          conversationTimelineViewModelProvider(_identity),
        );
        expect(
          [
            ...state.beforeMessages,
            ...state.afterMessages,
          ].map((message) => message.serverMessageId),
          containsAll(<int>[40, 60]),
        );
        expect(state.canLoadNewer, isFalse);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, -900));
        await tester.pumpAndSettle();

        expect(api.requests.any((request) => request.after != null), isFalse);
        _expectRowVisibleInViewport(tester, 60);
      },
    );

    // Use case:
    // A push notification can point at message 40, but that message may have
    // been recalled before the user opens the app. Backend around=40 filters the
    // deleted row out and returns nearby visible rows; the timeline should
    // render the nearest row instead of spinning forever.
    testWidgets(
      'message launch stops loading when recalled target is omitted',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            40: _response(
              messages: <MessageItemDto>[
                ..._messages(36, 39),
                ..._messages(41, 60),
              ],
              nextCursor: '35',
              prevCursor: null,
            ),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: const LaunchRequest.message(
            messageId: 40,
            highlight: false,
          ),
        );
        await _settleTimeline(tester);

        expect(api.requests.any((request) => request.around == 40), isTrue);
        expect(find.byType(CupertinoActivityIndicator), findsNothing);
        _expectRowVisibleInViewport(tester, 41);
      },
    );

    // Use case:
    // The user opens around a historical message and scrolls toward newer
    // content. If the first newer page is too short to fill the bottom edge, the
    // viewport should keep requesting newer pages until it has renderable rows.
    testWidgets(
      'continues loading newer messages when first newer page leaves viewport at edge',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            58: _response(
              messages: _messages(36, 60),
              nextCursor: '35',
              prevCursor: '61',
            ),
          },
          afterResponses: {
            60: _response(messages: _messages(61, 62), prevCursor: '63'),
            62: _response(messages: _messages(63, 80), prevCursor: null),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.message(
            messageId: 58,
            highlight: false,
          ),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 58);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, -160));
        await tester.pump();
        await tester.pump();

        expect(api.requests.any((request) => request.after == 60), isTrue);
        expect(api.requests.any((request) => request.after == 62), isTrue);
        _expectRowVisibleInViewport(tester, 63);
      },
    );

    // Use case:
    // Same as the short-page case, but the newer response arrives
    // asynchronously. Once the delayed page is inserted while the viewport is
    // still at the bottom edge, loading should continue without another drag.
    testWidgets(
      'continues loading newer messages after a delayed newer page resolves at edge',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            58: _response(
              messages: _messages(36, 60),
              nextCursor: '35',
              prevCursor: '61',
            ),
          },
          afterResponses: {
            60: _response(messages: _messages(61, 62), prevCursor: '63'),
            62: _response(messages: _messages(63, 80), prevCursor: null),
          },
          responseDelay: const Duration(milliseconds: 50),
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.message(
            messageId: 58,
            highlight: false,
          ),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 58);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, -160));
        await tester.pump();
        expect(api.requests.any((request) => request.after == 60), isTrue);

        await tester.pump(const Duration(milliseconds: 50));
        await tester.pump();

        expect(api.requests.any((request) => request.after == 62), isTrue);
        _expectRowVisibleInViewport(tester, 63);
      },
    );

    // Use case:
    // Unread launch around lastRead=20 returns the first unread page, then the
    // user scrolls toward newer messages. The timeline should issue after=40
    // and render the loaded latest row instead of stopping at the first window.
    testWidgets(
      'loads newer messages after unread launch omits read boundary',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
          afterResponses: {
            40: _response(messages: _messages(41, 60), prevCursor: null),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 21);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, -900));
        await tester.pumpAndSettle();

        expect(api.requests.any((request) => request.after == 40), isTrue);
        await tester.pump(const Duration(milliseconds: 16));
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 60);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The user opens a chat from unread state, starts around the first unread
    // row, then scrolls down until the app loads the final newer page. This
    // maps to the suspected blink: the unread window is still conceptually an
    // around/top-preferred view, but the final page reaches latest and queues a
    // live-edge settle. The test captures the first frame that renders the new
    // page before post-frame settle can hide a one-frame anchor jump.
    testWidgets(
      'unread newer page reaching latest does not paint a bottom-anchor frame',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
          afterResponses: {
            40: _response(messages: _messages(41, 60), prevCursor: null),
          },
          responseDelay: const Duration(milliseconds: 50),
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 21);

        _jumpToCurrentBottom(tester);
        await tester.pump();
        expect(api.requests.any((request) => request.after == 40), isTrue);
        final row40BeforeLatestPage = tester.getRect(_rowFinder(40));

        // Resolve the delayed after=40 response. Depending on exactly when the
        // future completes, this pump may only schedule the rebuild; the next
        // captured frame is the one that matters for the visual glitch.
        await tester.pump(const Duration(milliseconds: 50));

        final firstLatestFrame = await _captureNextFrameLayout(
          tester,
          rowFinder: _rowFinder(40),
        );

        expect(firstLatestFrame.scrollAnchor, lessThan(0.99));
        expect(
          firstLatestFrame.rowRect?.top,
          closeTo(row40BeforeLatestPage.top, 2),
        );

        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // Same unread-to-latest transition as above, but this assertion focuses on
    // the actual blink the user sees. Message 40 is visible before the final
    // newer page arrives; the first frame that includes messages 41..60 should
    // not move row 40 far away and rely on a later post-frame jump to correct
    // the viewport.
    testWidgets(
      'unread newer page reaching latest keeps stable row in place on first frame',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
          afterResponses: {
            40: _response(messages: _messages(41, 60), prevCursor: null),
          },
          responseDelay: const Duration(milliseconds: 50),
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 21);

        _jumpToCurrentBottom(tester);
        await tester.pump();
        expect(api.requests.any((request) => request.after == 40), isTrue);
        final row40BeforeLatestPage = tester.getRect(_rowFinder(40));

        // Resolve after=40, then inspect the very next painted frame. A large
        // delta here maps to the one-frame visual jump before settleToLiveEdge
        // corrects the scroll offset.
        await tester.pump(const Duration(milliseconds: 50));

        final firstLatestFrame = await _captureNextFrameLayout(
          tester,
          rowFinder: _rowFinder(40),
        );

        expect(firstLatestFrame.rowRect, isNotNull);
        expect(
          firstLatestFrame.rowRect!.top,
          closeTo(row40BeforeLatestPage.top, 2),
        );

        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // Backend around lastRead=20 can omit the read-boundary row and return only
    // unread rows 21..40. The unread launch should still stop bootstrapping and
    // reveal the first unread message.
    testWidgets(
      'unread launch renders first unread row when response omits read boundary',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: null,
            ),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await _settleTimeline(tester);

        expect(api.requests.any((request) => request.around == 20), isTrue);
        expect(find.byType(CupertinoActivityIndicator), findsNothing);
        _expectRowVisibleInViewport(tester, 21);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // Unread launch can return only unread rows and still already be at the
    // latest slice. If the keyboard opens in that state, the tail should move
    // above the compose area instead of staying below the shrunken viewport.
    testWidgets(
      'keeps omitted-boundary unread tail pinned when viewport shrinks',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(21, 30), nextCursor: '20'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 30);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();

        _expectRowBottomPinnedToViewport(tester, 30);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The user opens a chat with only a handful of unread rows, so every unread
    // message fits on screen. The first keyboard focus should settle with the
    // whole unread set visible, not require a dismiss/refocus cycle before the
    // tail anchors correctly.
    testWidgets(
      'keeps small unread set visible after first keyboard focus settles',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(20, 26), nextCursor: '19'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();
        for (var id = 21; id <= 26; id++) {
          _expectRowFullyVisibleInViewport(tester, id);
        }
        _expectRowBottomPinnedToViewport(tester, 26);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();

        for (var id = 21; id <= 26; id++) {
          _expectRowFullyVisibleInViewport(tester, id);
        }
        _expectRowBottomPinnedToViewport(tester, 26);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The real conversation surface keeps the scaffold size fixed and grows the
    // composer by MediaQuery.viewInsets when the keyboard opens. A small unread
    // set that fit above the composer before focus should still settle fully
    // above the expanded composer on the first focus.
    testWidgets(
      'keeps small unread set above composer on first keyboard focus frame',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(21, 26), nextCursor: '20'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpConversationSurface(
          tester,
          container: container,
          keyboardInset: 0,
          launchRequest: launchRequest,
        );
        await _pumpUntilRowExists(tester, 26);
        for (var id = 21; id <= 26; id++) {
          _expectRowFullyAboveComposer(tester, id);
        }

        await tester.tap(find.byType(EditableText));
        await tester.pump();
        await _pumpConversationSurface(
          tester,
          container: container,
          keyboardInset: 240,
          launchRequest: launchRequest,
        );
        await tester.pump();

        for (var id = 21; id <= 26; id++) {
          _expectRowFullyAboveComposer(tester, id);
        }
        _expectRowBottomPinnedToComposer(tester, 26);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The first unread row is temporarily highlighted to orient the user after
    // launch. When that highlight expires, only the row decoration should
    // change; the first clear frame should not hide the scrollable, swap the
    // top-preferred anchor, or issue a viewport command that can cause a flash.
    testWidgets(
      'keeps unread timeline stable on the first frame highlight clears',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(21, 26), nextCursor: '20'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: launchRequest,
        );
        await _pumpUntilRowExists(tester, 26);
        await _settleTimeline(tester);

        final stateBefore = container.read(
          conversationTimelineViewModelProvider(_identity),
        );
        final row21Before = tester.getRect(_rowFinder(21));
        final row26Before = tester.getRect(_rowFinder(26));
        final anchorBefore = _scrollAnchor(tester);
        expect(stateBefore.highlight, isNotNull);
        expect(_timelineOpacity(tester), 1);

        await tester.pump(ConversationMessageHighlight.totalDuration);

        final stateAfter = container.read(
          conversationTimelineViewModelProvider(_identity),
        );
        expect(find.byType(CupertinoActivityIndicator), findsNothing);
        expect(find.byType(CustomScrollView), findsOneWidget);
        expect(_timelineOpacity(tester), 1);
        expect(_scrollAnchor(tester), closeTo(anchorBefore, 0.001));
        expect(
          stateAfter.viewportCommandGeneration,
          stateBefore.viewportCommandGeneration,
        );
        expect(tester.getRect(_rowFinder(21)).top, closeTo(row21Before.top, 1));
        expect(
          tester.getRect(_rowFinder(26)).bottom,
          closeTo(row26Before.bottom, 1),
        );
      },
    );

    // Use case:
    // Unread launch can land on a window that already reaches latest. If the
    // user is at that unread live edge, a new incoming message should pin to the
    // bottom like latest mode.
    testWidgets(
      'pins incoming message after unread launch reaches latest slice',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(20, 21), nextCursor: '19'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        await tester.drag(find.byType(CustomScrollView), const Offset(0, -48));
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 21);

        _appendMessage(container, _message(22));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 22);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // After unread launch reaches latest and the user is at the unread tail, a
    // keyboard-style viewport shrink should keep the latest unread row visible
    // instead of hiding it below the compose area.
    testWidgets(
      'keeps unread latest row pinned when unread live-edge viewport shrinks',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(20, 21), nextCursor: '19'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();
        await tester.drag(find.byType(CustomScrollView), const Offset(0, -48));
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 21);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();

        _expectRowBottomPinnedToViewport(tester, 21);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // A realtime message from another user arrives while latest mode is already
    // bottom anchored. This should follow the live edge just like a self-send
    // would, even though there is no explicit composer scroll command.
    testWidgets(
      'pins other-user incoming message when latest live edge is bottom anchored',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        _appendMessage(container, _message(21, senderUid: 99));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 21);
        _expectJumpToLatestHidden();
      },
    );

    // Use case:
    // A realtime message from another user arrives while latest mode is already
    // bottom anchored. It should move into view with the same scroll animation
    // shape as a local send, not jump directly to the new max scroll extent.
    testWidgets(
      'animates other-user incoming message when latest live edge is bottom anchored',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);
        final beforeAppend = _scrollMetrics(tester);

        _appendMessage(container, _message(21, senderUid: 99));
        await tester.pump();

        final firstFrame = _scrollMetrics(tester);
        expect(firstFrame.max, greaterThan(beforeAppend.max));
        expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

        await tester.pump();
        await tester.pump(const Duration(milliseconds: 80));
        final animationFrame = _scrollMetrics(tester);
        expect(animationFrame.pixels, greaterThan(firstFrame.pixels));
        expect(animationFrame.pixels, lessThan(animationFrame.max - 1));

        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 21);
        _expectJumpToLatestHidden();
      },
    );

    // Use case:
    // Unread launch can start in an around window, then the user scrolls down
    // until the newer page reaches latest. Once the timeline has settled to
    // that unread tail, a realtime message from another user should still
    // follow live edge even though the active mode is not literal latest mode.
    testWidgets(
      'pins other-user incoming message after unread pagination reaches latest tail',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
          afterResponses: {
            40: _response(messages: _messages(41, 60), prevCursor: null),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _jumpToCurrentBottom(tester);
        await tester.pumpAndSettle();
        expect(api.requests.any((request) => request.after == 40), isTrue);
        await tester.pump(const Duration(milliseconds: 16));
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 60);

        _appendMessage(container, _message(61, senderUid: 99));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 61);
        _expectJumpToLatestHidden();
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // Unread/history launch can still become live edge after the user scrolls
    // down and newer pagination reaches latest. A realtime message from another
    // user should animate into view there too, even though the active mode is
    // history-shaped rather than plain latest mode.
    testWidgets(
      'animates other-user incoming message after unread pagination reaches latest tail',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
          afterResponses: {
            40: _response(messages: _messages(41, 60), prevCursor: null),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _jumpToCurrentBottom(tester);
        await tester.pumpAndSettle();
        expect(api.requests.any((request) => request.after == 40), isTrue);
        await tester.pump(const Duration(milliseconds: 16));
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 60);
        final beforeAppend = _scrollMetrics(tester);

        _appendMessage(container, _message(61, senderUid: 99));
        await tester.pump();

        final firstFrame = _scrollMetrics(tester);
        expect(firstFrame.max, greaterThan(beforeAppend.max));
        expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

        await tester.pump();
        await tester.pump(const Duration(milliseconds: 80));
        final animationFrame = _scrollMetrics(tester);
        expect(animationFrame.pixels, greaterThan(firstFrame.pixels));
        expect(animationFrame.pixels, lessThan(animationFrame.max - 1));

        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 61);
        _expectJumpToLatestHidden();
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The chat is open on an empty latest timeline and the first realtime
    // message arrives from another user. The row should appear and be treated
    // as live edge, not be dropped because there was no prior latest segment.
    testWidgets(
      'renders first other-user incoming message in empty latest conversation',
      (tester) async {
        final api = _FakeMessageApiService(const []);
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        expect(find.byType(CupertinoActivityIndicator), findsNothing);

        _appendMessage(container, _message(1, senderUid: 99));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 1);
        _expectJumpToLatestHidden();
      },
    );

    // Use case:
    // A larger incoming message can push the old tail out of view on the first
    // layout pass. If the user was already at live edge, the timeline should
    // settle to the new tall row instead of leaving the jump-to-bottom control.
    testWidgets(
      'pins tall other-user incoming message when latest live edge is bottom anchored',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        _appendMessage(
          container,
          _message(21, senderUid: 99, text: _multiLineText('message 21', 8)),
        );
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 21);
        _expectJumpToLatestHidden();
      },
    );

    // Use case:
    // The user is still inside the live-edge follow threshold but not exactly
    // tail-pinned. A larger incoming message should still follow; otherwise the
    // new row remains below the viewport and only the jump-to-bottom FAB shows.
    testWidgets(
      'pins tall other-user incoming message when viewport is near live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);
        await _moveSlightlyAwayFromLiveEdge(tester);

        _appendMessage(
          container,
          _message(21, senderUid: 99, text: _multiLineText('message 21', 8)),
        );
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 21);
        _expectJumpToLatestHidden();
      },
    );

    // Use case:
    // Combine unread live-edge mode, viewport shrink, and a newly incoming
    // message. The timeline should preserve tail visibility after the resize and
    // then pin the appended row.
    testWidgets(
      'pins incoming message after unread live-edge viewport shrinks',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(messages: _messages(20, 21), nextCursor: '19'),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);
        const launchRequest = LaunchRequest.unread(lastReadMessageId: 20);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 600,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();
        await tester.drag(find.byType(CustomScrollView), const Offset(0, -48));
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 21);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: launchRequest,
        );
        await tester.pumpAndSettle();
        _expectRowBottomPinnedToViewport(tester, 21);

        _appendMessage(container, _message(22));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 22);
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // Latest data can be entirely before the CustomScrollView center sliver
    // during live-edge mode. Appending a new message should still move the tail
    // to the viewport bottom.
    testWidgets(
      'pins incoming message when latest segment is entirely before center',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        _appendMessage(container, _message(21));
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );

    // Use case:
    // The user is at live edge, the keyboard shrinks the viewport, and then a
    // realtime message arrives. The appended row should be visible at the bottom
    // after both layout and data changes settle.
    testWidgets('pins incoming message after live-edge viewport shrinks', (
      tester,
    ) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);

      await _pumpTimeline(tester, container: container, viewportHeight: 360);
      await tester.pump();
      _appendMessage(container, _message(21));
      await _settleLiveEdgeAnimation(tester);

      _expectRowBottomPinnedToViewport(tester, 21);
    });

    // Use case:
    // A local optimistic send happens while the user is already at live edge.
    // The timeline should hand that case to scrollToBottom's animation rather
    // than first jumping directly to the new max scroll extent.
    testWidgets(
      'animates own optimistic message to bottom when already at live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);
        final beforeSend = _scrollMetrics(tester);

        final notifier = container.read(
          conversationTimelineViewModelProvider(_identity).notifier,
        );
        final intent = notifier.captureLocalSendViewportIntent();
        _appendConversationMessage(
          container,
          _optimisticTextMessage(
            clientGeneratedId: 'local-send-21',
            senderUid: 1,
            text: 'local send 21',
          ),
        );
        container
            .read(conversationTimelineViewModelProvider(_identity).notifier)
            .applyLocalSendViewportIntent(intent);
        await tester.pump();

        final firstFrame = _scrollMetrics(tester);
        expect(firstFrame.max, greaterThan(beforeSend.max));
        expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

        await tester.pump();
        await tester.pump(const Duration(milliseconds: 80));
        final animationFrame = _scrollMetrics(tester);
        expect(animationFrame.pixels, greaterThan(firstFrame.pixels));
        expect(animationFrame.pixels, lessThan(animationFrame.max - 1));

        await tester.pumpAndSettle();
        _expectClientRowBottomPinnedToViewport(tester, 'local-send-21');
      },
    );

    // Use case:
    // The user is still within the near-bottom threshold, not exactly pinned,
    // and the latest message grows because reactions are added. Near-live-edge
    // policy should re-pin the latest row.
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

    // Use case:
    // The user is near live edge and a row above latest grows, such as a
    // reaction or media metadata update on message 19. Even though the tail row
    // did not change, the latest message should remain pinned.
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

    // Use case:
    // The user is near live edge but not exactly at the tail, then the viewport
    // shrinks. The timeline should treat this as follow-live-edge and keep the
    // latest message visible.
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

    // Use case:
    // A near-live-edge viewport shrink and latest-row mutation happen together.
    // This protects the combined case that most closely resembles keyboard open
    // plus a realtime reaction update.
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

    // Use case:
    // The user is within the near-bottom threshold and a new message arrives.
    // The timeline should follow the append and pin the new row instead of
    // preserving the old scroll offset.
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
      await _settleLiveEdgeAnimation(tester);

      _expectRowBottomPinnedToViewport(tester, 21);
    });

    // Use case:
    // Near-live-edge state, keyboard shrink, and a new append happen in order.
    // The new message should still be pinned after the viewport size change.
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
        await _settleLiveEdgeAnimation(tester);

        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );

    // Use case:
    // The user is intentionally reading history, well outside the live-edge
    // follow threshold, when another user sends a new message. The new message
    // should not yank the viewport away from the historical row being read.
    testWidgets(
      'keeps browsing position when incoming message arrives away from live edge',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 60));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 60);

        await tester.drag(find.byType(CustomScrollView), const Offset(0, 520));
        await tester.pumpAndSettle();
        final beforeAppend = _scrollMetrics(tester);
        final anchorBefore = _visibleServerRowClosestToCenter(
          tester,
          List<int>.generate(60, (index) => index + 1),
        );

        _appendMessage(container, _message(61, senderUid: 99));
        await tester.pumpAndSettle();

        final afterAppend = _scrollMetrics(tester);
        final anchorAfter = tester.getRect(_rowFinder(anchorBefore.messageId));
        expect(afterAppend.pixels, closeTo(beforeAppend.pixels, 1));
        expect(anchorAfter.top, closeTo(anchorBefore.rect.top, 1));
        _expectJumpToLatestVisible();
      },
    );

    // Use case:
    // Several realtime messages arrive as one burst while the user is at live
    // edge. The timeline should animate once toward the final newest row and
    // settle on that final tail, not stop on an intermediate message.
    testWidgets('animates a burst of incoming messages to the final tail', (
      tester,
    ) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);
      final beforeAppend = _scrollMetrics(tester);

      _appendMessage(container, _message(21, senderUid: 99));
      _appendMessage(container, _message(22, senderUid: 99));
      _appendMessage(container, _message(23, senderUid: 99));
      await tester.pump();

      final firstFrame = _scrollMetrics(tester);
      expect(firstFrame.max, greaterThan(beforeAppend.max));
      expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));
      final animationFrame = _scrollMetrics(tester);
      expect(animationFrame.pixels, greaterThan(firstFrame.pixels));
      expect(animationFrame.pixels, lessThan(animationFrame.max - 1));

      await tester.pumpAndSettle();
      _expectRowBottomPinnedToViewport(tester, 23);
      _expectJumpToLatestHidden();
    });

    // Use case:
    // A realtime live-edge animation starts, but the user immediately scrolls
    // away to keep reading. User intent should cancel the auto-follow animation
    // instead of snapping back to the tail after the gesture ends.
    testWidgets('lets user scroll away during incoming-message animation', (
      tester,
    ) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);

      _appendMessage(container, _message(21, senderUid: 99));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));
      await tester.drag(find.byType(CustomScrollView), const Offset(0, 240));
      await tester.pumpAndSettle();

      final metrics = _scrollMetrics(tester);
      expect(metrics.pixels, lessThan(metrics.max - 1));
      _expectJumpToLatestVisible();
    });

    // Use case:
    // A local optimistic send starts its scroll animation, then the server echo
    // arrives with the same clientGeneratedId. Reconciliation should replace the
    // optimistic row in place without duplicating the message or jumping to the
    // final offset before the animation completes.
    testWidgets(
      'keeps self-send animation stable during server echo reconcile',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        final notifier = container.read(
          conversationTimelineViewModelProvider(_identity).notifier,
        );
        final intent = notifier.captureLocalSendViewportIntent();
        _appendConversationMessage(
          container,
          _optimisticTextMessage(
            clientGeneratedId: 'local-send-21',
            senderUid: 1,
            text: 'local send 21',
          ),
        );
        notifier.applyLocalSendViewportIntent(intent);
        await tester.pump();

        final firstFrame = _scrollMetrics(tester);
        expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

        _appendMessage(
          container,
          _message(
            21,
            senderUid: 1,
            text: 'local send 21',
            clientGeneratedId: 'local-send-21',
          ),
        );
        await tester.pump();

        final reconcileFrame = _scrollMetrics(tester);
        expect(reconcileFrame.pixels, lessThan(reconcileFrame.max - 1));
        expect(_clientRowFinder('local-send-21'), findsOneWidget);

        await tester.pumpAndSettle();
        expect(_clientRowFinder('local-send-21'), findsOneWidget);
        expect(_rowFinder(21), findsOneWidget);
        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );

    testWidgets('failed local message action sheet retries the send', (
      tester,
    ) async {
      ApiSession.updateSession(
        userId: 1,
        authHeaders: legacyApiAuthHeadersForUser(1),
      );
      final api = _FakeMessageApiService(const []);
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      await container
          .read(conversationOutboundMessageQueueProvider(_identity))
          .enqueue(
            optimisticMessage: _optimisticTextMessage(
              clientGeneratedId: 'failed-local-1',
              senderUid: 1,
              text: 'retry me',
            ),
            attachmentIds: const <String>[],
          );
      await tester.pump();
      expect(api.sendRequests.map((request) => request.clientGeneratedId), [
        'failed-local-1',
      ]);

      api.failNextSend();
      await tester.pump();
      await tester.pump();

      expect(find.byKey(messageRowFailedActionKey), findsOneWidget);

      await tester.tap(find.byKey(messageRowFailedActionKey));
      await tester.pumpAndSettle();
      expect(find.text('Message failed to send'), findsOneWidget);

      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(api.sendRequests.map((request) => request.clientGeneratedId), [
        'failed-local-1',
        'failed-local-1',
      ]);
      expect(find.byKey(messageRowFailedActionKey), findsNothing);

      api.completeNextSend(id: 21);
      await tester.pumpAndSettle();

      expect(_clientRowFinder('failed-local-1'), findsOneWidget);
      expect(_rowFinder(21), findsOneWidget);
    });

    testWidgets('failed local message action sheet discards the send', (
      tester,
    ) async {
      ApiSession.updateSession(
        userId: 1,
        authHeaders: legacyApiAuthHeadersForUser(1),
      );
      final api = _FakeMessageApiService(const []);
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      await container
          .read(conversationOutboundMessageQueueProvider(_identity))
          .enqueue(
            optimisticMessage: _optimisticTextMessage(
              clientGeneratedId: 'failed-local-2',
              senderUid: 1,
              text: 'discard me',
            ),
            attachmentIds: const <String>[],
          );
      await tester.pump();
      api.failNextSend();
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(messageRowFailedActionKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete Message'));
      await tester.pumpAndSettle();

      expect(_clientRowFinder('failed-local-2'), findsNothing);
    });

    // Use case:
    // The latest message is recalled or deleted while the user is at live edge.
    // The removed tail should disappear and the previous row should become the
    // pinned live edge without leaving the scrollable in an invalid state.
    testWidgets('pins previous row when live tail is deleted', (tester) async {
      final api = _FakeMessageApiService(_messages(1, 20));
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowBottomPinnedToViewport(tester, 20);

      _deleteMessage(container, 20);
      await tester.pumpAndSettle();

      expect(_rowFinder(20), findsNothing);
      _expectRowBottomPinnedToViewport(tester, 19);
      expect(find.byType(CupertinoActivityIndicator), findsNothing);
    });

    // Use case:
    // The user is reading the unread/history window and has not reached live
    // edge yet. Fresh live traffic should not steal the viewport away from the
    // unread row being read.
    testWidgets(
      'keeps unread browsing position when incoming message arrives before live edge',
      (tester) async {
        final api = _FakeMessageApiService(
          const [],
          aroundResponses: {
            20: _response(
              messages: _messages(21, 40),
              nextCursor: '20',
              prevCursor: '41',
            ),
          },
        );
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(
          tester,
          container: container,
          viewportHeight: 360,
          launchRequest: const LaunchRequest.unread(lastReadMessageId: 20),
        );
        await tester.pumpAndSettle();
        _expectRowVisibleInViewport(tester, 21);
        final anchorBefore = _visibleServerRowClosestToCenter(
          tester,
          List<int>.generate(20, (index) => index + 21),
        );

        _appendMessage(container, _message(61, senderUid: 99));
        await tester.pumpAndSettle();

        final anchorAfter = tester.getRect(_rowFinder(anchorBefore.messageId));
        expect(anchorAfter.top, closeTo(anchorBefore.rect.top, 1));
        _expectJumpToLatestVisible();
        await _flushHighlightClearTimer(tester);
      },
    );

    // Use case:
    // The user is reading a visible latest-window row while older history loads
    // above it. Inserting older rows should preserve the visible row's viewport
    // position in the production widget, not only in the sliver harness.
    testWidgets('preserves visible row when older messages load above it', (
      tester,
    ) async {
      final api = _FakeMessageApiService(
        const [],
        latestResponse: _response(
          messages: _messages(21, 40),
          nextCursor: '20',
        ),
        beforeResponses: {
          21: _response(messages: _messages(1, 20), nextCursor: null),
        },
      );
      final container = await _container(api);
      addTearDown(container.dispose);

      await _pumpTimeline(tester, container: container, viewportHeight: 600);
      await _settleTimeline(tester);
      _expectRowVisibleInViewport(tester, 30);
      final row30Before = tester.getRect(_rowFinder(30));

      await container
          .read(conversationTimelineViewModelProvider(_identity).notifier)
          .loadOlder();
      await tester.pumpAndSettle();

      expect(api.requests.any((request) => request.before == 21), isTrue);
      final row30After = tester.getRect(_rowFinder(30));
      expect(row30After.top, closeTo(row30Before.top, 1));
    });

    // Use case:
    // A realtime append starts animating toward live edge, then the keyboard
    // opens and shrinks the viewport before the animation completes. The final
    // target should account for the new viewport size and keep the new tail
    // pinned.
    testWidgets(
      'keeps appended tail pinned when viewport shrinks mid-animation',
      (tester) async {
        final api = _FakeMessageApiService(_messages(1, 20));
        final container = await _container(api);
        addTearDown(container.dispose);

        await _pumpTimeline(tester, container: container, viewportHeight: 600);
        await _settleTimeline(tester);
        _expectRowBottomPinnedToViewport(tester, 20);

        _appendMessage(container, _message(21, senderUid: 99));
        await tester.pump();
        final firstFrame = _scrollMetrics(tester);
        expect(firstFrame.pixels, lessThan(firstFrame.max - 1));

        await tester.pump();
        await tester.pump(const Duration(milliseconds: 80));
        await _pumpTimeline(tester, container: container, viewportHeight: 360);
        await tester.pumpAndSettle();

        _expectRowBottomPinnedToViewport(tester, 21);
        _expectJumpToLatestHidden();
      },
    );
  });
}

const _identity = (chatId: 42, threadRootId: null);
const _threadIdentity = (chatId: 42, threadRootId: 100);
const _viewportKey = ValueKey<String>('conversation-timeline-test-viewport');
const _surfaceKey = ValueKey<String>('conversation-surface-test-viewport');

Future<ProviderContainer> _container(_FakeMessageApiService api) async {
  final preferences = AppPreferences.withData(const <String, Object>{});
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
  LaunchRequest launchRequest = const LaunchRequest.latest(),
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
                launchRequest: launchRequest,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

Future<void> _pumpConversationSurface(
  WidgetTester tester, {
  required ProviderContainer container,
  required double keyboardInset,
  LaunchRequest launchRequest = const LaunchRequest.latest(),
}) async {
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: CupertinoApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: MediaQuery(
          data: MediaQueryData(
            size: const Size(390, 600),
            viewInsets: EdgeInsets.only(bottom: keyboardInset),
          ),
          child: SizedBox(
            key: _surfaceKey,
            width: 390,
            height: 600,
            child: ConversationSurfaceV2(
              identity: _threadIdentity,
              launchRequest: launchRequest,
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

Future<void> _pumpUntilRowExists(WidgetTester tester, int messageId) async {
  for (var attempt = 0; attempt < 8; attempt++) {
    await tester.pump();
    if (_rowFinder(messageId).evaluate().isNotEmpty) {
      return;
    }
  }
  expect(_rowFinder(messageId), findsOneWidget);
}

Future<void> _settleLiveEdgeAnimation(WidgetTester tester) async {
  await tester.pump();
  await tester.pumpAndSettle();
}

Future<void> _flushHighlightClearTimer(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 4));
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

void _appendConversationMessage(
  ProviderContainer container,
  ConversationMessageV2 message,
) {
  container
      .read(conversationTimelineMessageStoreProvider.notifier)
      .newMessage(_identity, message);
}

void _deleteMessage(ProviderContainer container, int serverMessageId) {
  container
      .read(conversationTimelineMessageStoreProvider.notifier)
      .deleteMessage(_identity, serverMessageId);
}

Future<void> _moveSlightlyAwayFromLiveEdge(WidgetTester tester) async {
  await tester.drag(find.byType(CustomScrollView), const Offset(0, 48));
  await tester.pump();
}

void _jumpToCurrentBottom(WidgetTester tester) {
  final position = tester
      .state<ScrollableState>(find.byType(Scrollable))
      .position;
  position.jumpTo(position.maxScrollExtent);
}

void _expectRowBottomPinnedToViewport(WidgetTester tester, int messageId) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(_rowFinder(messageId));
  expect(row.bottom, closeTo(viewport.bottom, 1));
  expect(row.top < viewport.bottom, isTrue);
}

void _expectClientRowBottomPinnedToViewport(
  WidgetTester tester,
  String clientGeneratedId,
) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(_clientRowFinder(clientGeneratedId));
  expect(row.bottom, closeTo(viewport.bottom, 1));
  expect(row.top < viewport.bottom, isTrue);
}

void _expectJumpToLatestHidden() {
  expect(find.byType(JumpToLatestFab), findsNothing);
}

void _expectJumpToLatestVisible() {
  expect(find.byType(JumpToLatestFab), findsOneWidget);
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

void _expectRowFullyVisibleInViewport(WidgetTester tester, int messageId) {
  final finder = _rowFinder(messageId);
  expect(finder, findsOneWidget);
  final viewport = tester.getRect(find.byKey(_viewportKey));
  final row = tester.getRect(finder);
  expect(row.top, greaterThanOrEqualTo(viewport.top));
  expect(row.bottom, lessThanOrEqualTo(viewport.bottom));
}

void _expectRowFullyAboveComposer(WidgetTester tester, int messageId) {
  final finder = _rowFinder(messageId);
  expect(finder, findsOneWidget);
  final surface = tester.getRect(find.byKey(_surfaceKey));
  final composer = tester.getRect(find.byType(ConversationComposeV2));
  final row = tester.getRect(finder);
  expect(row.top, greaterThanOrEqualTo(surface.top));
  expect(row.bottom, lessThanOrEqualTo(composer.top));
}

void _expectRowBottomPinnedToComposer(WidgetTester tester, int messageId) {
  final composer = tester.getRect(find.byType(ConversationComposeV2));
  final row = tester.getRect(_rowFinder(messageId));
  expect(row.bottom, closeTo(composer.top, 1));
}

({int messageId, Rect rect}) _visibleServerRowClosestToCenter(
  WidgetTester tester,
  Iterable<int> messageIds,
) {
  final viewport = tester.getRect(find.byKey(_viewportKey));
  ({int messageId, Rect rect, double distance})? best;
  for (final messageId in messageIds) {
    final finder = _rowFinder(messageId);
    if (finder.evaluate().length != 1) {
      continue;
    }
    final rect = tester.getRect(finder);
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
      continue;
    }
    final distance = (rect.center.dy - viewport.center.dy).abs();
    if (best == null || distance < best.distance) {
      best = (messageId: messageId, rect: rect, distance: distance);
    }
  }
  expect(best, isNotNull);
  return (messageId: best!.messageId, rect: best.rect);
}

({double pixels, double max}) _scrollMetrics(WidgetTester tester) {
  final position = tester
      .state<ScrollableState>(find.byType(Scrollable))
      .position;
  return (pixels: position.pixels, max: position.maxScrollExtent);
}

double _scrollAnchor(WidgetTester tester) {
  return tester.widget<CustomScrollView>(find.byType(CustomScrollView)).anchor;
}

double _timelineOpacity(WidgetTester tester) {
  final opacity = find.ancestor(
    of: find.byType(CustomScrollView),
    matching: find.byType(Opacity),
  );
  expect(opacity, findsOneWidget);
  return tester.widget<Opacity>(opacity).opacity;
}

Future<({Rect? rowRect, double scrollAnchor})> _captureNextFrameLayout(
  WidgetTester tester, {
  required Finder rowFinder,
}) async {
  Rect? rowRect;
  double? scrollAnchor;

  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (rowFinder.evaluate().length == 1) {
      rowRect = tester.getRect(rowFinder);
    }
    scrollAnchor = tester
        .widget<CustomScrollView>(find.byType(CustomScrollView))
        .anchor;
  });

  await tester.pump();
  return (rowRect: rowRect, scrollAnchor: scrollAnchor!);
}

Finder _rowFinder(int messageId) {
  return find.byWidgetPredicate(
    (widget) =>
        widget is MessageRowV2 && widget.message.serverMessageId == messageId,
    description: 'MessageRowV2 for server message $messageId',
    skipOffstage: false,
  );
}

Finder _clientRowFinder(String clientGeneratedId) {
  return find.byWidgetPredicate(
    (widget) =>
        widget is MessageRowV2 &&
        widget.message.clientGeneratedId == clientGeneratedId,
    description: 'MessageRowV2 for client message $clientGeneratedId',
    skipOffstage: false,
  );
}

List<MessageItemDto> _messages(int start, int end) {
  return [for (var id = start; id <= end; id++) _message(id)];
}

String _multiLineText(String prefix, int lineCount) {
  return [
    for (var index = 1; index <= lineCount; index++) '$prefix line $index',
  ].join('\n');
}

MessageItemDto _message(
  int id, {
  int reactionCount = 0,
  int senderUid = 7,
  String? text,
  String? clientGeneratedId,
}) {
  return MessageItemDto(
    id: id,
    message: text ?? 'message $id',
    sender: UserDto(uid: senderUid, name: 'Sender $senderUid'),
    chatId: _identity.chatId,
    clientGeneratedId: clientGeneratedId ?? 'client-$id',
    reactions: [
      for (var i = 0; i < reactionCount; i++)
        ReactionSummaryDto(emoji: 'r$i', count: i + 1),
    ],
  );
}

ConversationMessageV2 _optimisticTextMessage({
  required String clientGeneratedId,
  required int senderUid,
  required String text,
}) {
  return ConversationMessageV2(
    clientGeneratedId: clientGeneratedId,
    sender: User(uid: senderUid, name: 'Sender $senderUid'),
    createdAt: DateTime(2026, 1, 1),
    deliveryState: ConversationDeliveryState.sending,
    content: TextMessageContent(text: text),
  );
}

class _FakeMessageApiService extends MessageApiServiceV2 {
  _FakeMessageApiService(
    this.messages, {
    this.latestResponse,
    Map<int, ListMessagesResponseDto>? beforeResponses,
    Map<int, ListMessagesResponseDto>? aroundResponses,
    Map<int, ListMessagesResponseDto>? afterResponses,
    this.responseDelay,
  }) : beforeResponses = beforeResponses ?? const {},
       aroundResponses = aroundResponses ?? const {},
       afterResponses = afterResponses ?? const {},
       super(Dio(), 7);

  final List<MessageItemDto> messages;
  final ListMessagesResponseDto? latestResponse;
  final Map<int, ListMessagesResponseDto> beforeResponses;
  final Map<int, ListMessagesResponseDto> aroundResponses;
  final Map<int, ListMessagesResponseDto> afterResponses;
  final Duration? responseDelay;
  final requests = <({int? before, int? after, int? around, int? max})>[];
  final sendRequests = <_SendRequest>[];
  final _pendingSends = <Completer<MessageItemDto>>[];

  @override
  Future<ListMessagesResponseDto> fetchConversationMessages(
    ConversationIdentity identity, {
    int? max,
    int? before,
    int? after,
    int? around,
  }) async {
    requests.add((before: before, after: after, around: around, max: max));
    final beforeResponse = beforeResponses[before];
    if (beforeResponse != null) {
      return _maybeDelay(beforeResponse);
    }
    final aroundResponse = aroundResponses[around];
    if (aroundResponse != null) {
      return aroundResponse;
    }
    final afterResponse = afterResponses[after];
    if (afterResponse != null) {
      final delay = responseDelay;
      if (delay != null) {
        await Future<void>.delayed(delay);
      }
      return afterResponse;
    }
    if (before == null && after == null && around == null) {
      final response = latestResponse;
      if (response != null) {
        return _maybeDelay(response);
      }
    }
    return _maybeDelay(ListMessagesResponseDto(messages: messages));
  }

  Future<ListMessagesResponseDto> _maybeDelay(
    ListMessagesResponseDto response,
  ) async {
    final delay = responseDelay;
    if (delay != null) {
      await Future<void>.delayed(delay);
    }
    return response;
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

  @override
  Future<MessageItemDto> sendConversationMessage(
    ConversationIdentity identity,
    String text, {
    required String messageType,
    int? replyToId,
    List<String> attachmentIds = const <String>[],
    required String clientGeneratedId,
    String? stickerId,
  }) {
    sendRequests.add((
      text: text,
      messageType: messageType,
      clientGeneratedId: clientGeneratedId,
    ));
    final completer = Completer<MessageItemDto>();
    _pendingSends.add(completer);
    return completer.future;
  }

  void failNextSend() {
    _pendingSends.removeAt(0).completeError(Exception('offline'));
  }

  void completeNextSend({required int id}) {
    final request = sendRequests[sendRequests.length - _pendingSends.length];
    _pendingSends
        .removeAt(0)
        .complete(
          MessageItemDto(
            id: id,
            message: request.text,
            messageType: request.messageType,
            sender: const UserDto(uid: 1, name: 'Sender 1'),
            chatId: _identity.chatId,
            clientGeneratedId: request.clientGeneratedId,
          ),
        );
  }
}

typedef _SendRequest = ({
  String text,
  String messageType,
  String clientGeneratedId,
});

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
