import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_active_segment.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_canonical_scope.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final _identity = (chatId: 1, threadRootId: null);
const _sender = User(uid: 1, name: 'Alice');

void main() {
  group('ConversationTimelineV2CanonicalSegment', () {
    test('rejects empty segments', () {
      // Tests the invariant that canonical cache segments must contain at least
      // one message so the store never has to reason about empty ranges.
      expect(
        () => ConversationTimelineCanonicalSegment(orderedMessages: const []),
        throwsA(isA<AssertionError>()),
      );
    });

    test('rejects messages without server ids', () {
      // Tests the invariant that canonical cached segments are always ordered by
      // server id, so every message in the segment must have one.
      expect(
        () => ConversationTimelineCanonicalSegment(
          orderedMessages: [_message(null)],
        ),
        throwsA(isA<AssertionError>()),
      );
    });
  });

  group('ConversationTimelineV2MessageStore', () {
    group('insertBeforeAnchor', () {
      test('inserts the incoming segment into an empty scope', () {
        // Tests the base case: when nothing is cached yet, a before-anchor
        // fetch simply becomes the first cached segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.insertBeforeAnchor(_identity, 5, _segment(3, 4));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [3, 4],
        ]);
      });

      test('splits a segment that already contains the anchor', () {
        // Tests the main before-anchor refresh case: keep the stale older
        // prefix, replace the refreshed before-anchor interval, and preserve
        // the anchor itself as a trailing suffix segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 5)]));

        store.insertBeforeAnchor(_identity, 5, _segment(3, 4));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4, 5],
        ]);
      });

      test('split a segment', () {
        // Tests that cached history entirely before the incoming interval stays
        // untouched and ordered ahead of the fresh before-anchor slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 10)]));

        store.insertBeforeAnchor(_identity, 8, _segment(6, 7));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [5],
          [6, 7, 8, 9, 10],
        ]);
      });

      test('split a segment / remove elemtns if needed', () {
        // Tests that cached history entirely before the incoming interval stays
        // untouched and ordered ahead of the fresh before-anchor slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

        store.insertBeforeAnchor(_identity, 6, _segment(3, 4));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4, 6],
        ]);
      });

      test('keeps an older discontiguous segment before the refreshed slice', () {
        // Tests that cached history entirely before the incoming interval stays
        // untouched and ordered ahead of the fresh before-anchor slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

        store.insertBeforeAnchor(_identity, 5, _segment(3, 4));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4, 5, 6],
        ]);
      });

      test(
        'inserts before later segments that start at or after the anchor',
        () {
          // Tests that segments entirely on the anchor/newer side are preserved
          // after the new before-anchor slice without being modified.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(7, 8)]));

          store.insertBeforeAnchor(_identity, 7, _segment(1, 4));

          final segments = container
              .read(conversationTimelineMessageStoreProvider)[_identity]!
              .segments;
          expect(_segmentIds(segments), [
            [1, 2, 3, 4, 7, 8],
          ]);
        },
      );

      test('replaces overlapping ranges across multiple cached segments', () {
        // Tests that one fresh before-anchor slice can bridge multiple cached
        // segments: stale overlap is removed, older prefix survives, and the
        // anchor-side suffix is preserved.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertBeforeAnchor(_identity, 5, _segment(3, 4));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4, 5, 6],
        ]);
      });
      test('replace entire segments', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope([_segment(1, 3), _segment(4, 6), _segment(7, 9)]),
        );

        store.insertBeforeAnchor(_identity, 8, _segment(2, 7));

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1],
          [2, 3, 4, 5, 6, 7, 8, 9],
        ]);
      });
    });

    group('insertAfterAnchor', () {
      test('inserts the incoming segment into an empty scope', () {
        // Tests the base case: when nothing is cached yet, an after-anchor
        // fetch simply becomes the first cached segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.insertAfterAnchor(
          _identity,
          2,
          _segment(3, 4),
          hasReachedLatest: false,
        );

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [3, 4],
        ]);
      });

      test('splits a segment that already contains the anchor', () {
        // Tests the main after-anchor refresh case: keep the stale anchor-side
        // prefix attached to the refreshed after-anchor interval, and preserve
        // the newer suffix as a trailing segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 5)]));

        store.insertAfterAnchor(
          _identity,
          2,
          _segment(3, 4),
          hasReachedLatest: false,
        );

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2, 3, 4],
          [5],
        ]);
      });

      test('split a segment', () {
        // Tests the symmetric split case: keep stale newer messages that fall
        // after the refreshed after-anchor interval as a separate suffix.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 6), _segment(9, 10)]));

        store.insertAfterAnchor(
          _identity,
          3,
          _segment(4, 5),
          hasReachedLatest: false,
        );

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2, 3, 4, 5],
          [6],
          [9, 10],
        ]);
      });

      test('split a segment / remove elements if needed', () {
        // Tests the symmetric removal case: stale messages between the anchor
        // and the fresh after-anchor slice are dropped, while later disjoint
        // history remains separate.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

        store.insertAfterAnchor(
          _identity,
          1,
          _segment(3, 4),
          hasReachedLatest: false,
        );

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 3, 4],
          [5, 6],
        ]);
      });

      test(
        'keeps an older discontiguous segment before the refreshed slice',
        () {
          // Tests that a cached segment ending at the anchor becomes the
          // anchor-side continuation and attaches to the fresh after-anchor
          // slice, while truly newer segments remain separate.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

          store.insertAfterAnchor(
            _identity,
            2,
            _segment(3, 4),
            hasReachedLatest: false,
          );

          final segments = container
              .read(conversationTimelineMessageStoreProvider)[_identity]!
              .segments;
          expect(_segmentIds(segments), [
            [1, 2, 3, 4],
            [5, 6],
          ]);
        },
      );

      test(
        'inserts after earlier segments that end at or before the anchor',
        () {
          // Tests that a cached segment ending at the anchor becomes the
          // anchor-side continuation and attaches to the fresh after-anchor
          // slice, even when there is no newer cached segment yet.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(1, 2)]));

          store.insertAfterAnchor(
            _identity,
            2,
            _segment(3, 4),
            hasReachedLatest: false,
          );

          final segments = container
              .read(conversationTimelineMessageStoreProvider)[_identity]!
              .segments;
          expect(_segmentIds(segments), [
            [1, 2, 3, 4],
          ]);
        },
      );

      test('replaces overlapping ranges across multiple cached segments', () {
        // Tests that one fresh after-anchor slice can bridge multiple cached
        // segments: the stale overlap is removed, the anchor-side prefix stays
        // attached to the fresh slice, and the newer suffix remains cached
        // after it.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertAfterAnchor(
          _identity,
          2,
          _segment(3, 4),
          hasReachedLatest: false,
        );

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2, 3, 4],
          [5, 6],
        ]);
      });

      test('marks the merged tail as latest when the fetch reaches latest', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

        store.insertAfterAnchor(
          _identity,
          2,
          _segment(3, 4),
          hasReachedLatest: true,
        );

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2, 3, 4],
        ]);

        final activeSegment = container.read(
          conversationTimelineActiveSegmentProvider((
            identity: _identity,
            mode: const ConversationTimelineActiveSegmentMode.around(2),
          )),
        )!;
        expect(activeSegment.isLatestSlice, true);
        expect(activeSegment.canLoadAfter, false);
      });
    });

    group('insertAround', () {
      test('inserts the incoming segment into an empty scope', () {
        // Tests the base case: when nothing is cached yet, an around fetch
        // simply becomes the first cached segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.insertAround(_identity, _segment(3, 4), hasReachedLatest: false);

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [3, 4],
        ]);
      });

      test('splits a segment that overlaps the incoming range', () {
        // Tests the main around-refresh case: keep the stale prefix and suffix
        // outside the refreshed interval, and replace the covered range with
        // the incoming slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 5)]));

        store.insertAround(_identity, _segment(3, 4), hasReachedLatest: false);

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4],
          [5],
        ]);
      });

      test(
        'keeps discontiguous segments on both sides of the refreshed range',
        () {
          // Tests that cached segments fully before and fully after the incoming
          // interval remain untouched and ordered around the fresh slice.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

          store.insertAround(
            _identity,
            _segment(3, 4),
            hasReachedLatest: false,
          );

          final segments = container
              .read(conversationTimelineMessageStoreProvider)[_identity]!
              .segments;
          expect(_segmentIds(segments), [
            [1, 2],
            [3, 4],
            [5, 6],
          ]);
        },
      );

      test('inserts between discontiguous cached segments without overlap', () {
        // Tests that a fresh around-range with no overlap is inserted into the
        // correct ordered position between existing cached segments.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(7, 8)]));

        store.insertAround(_identity, _segment(4, 5), hasReachedLatest: false);

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [4, 5],
          [7, 8],
        ]);
      });

      test('replaces overlapping ranges across multiple cached segments', () {
        // Tests that one fresh around-range can bridge multiple cached
        // segments: stale overlap is removed and untouched outer ranges stay
        // as separate cached segments.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertAround(_identity, _segment(3, 4), hasReachedLatest: false);

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2],
          [3, 4],
          [5, 6],
        ]);
      });

      test('replaces entire segments', () {
        // Tests that one fresh around-range can bridge multiple cached
        // segments: stale overlap is removed and untouched outer ranges stay
        // as separate cached segments.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertAround(_identity, _segment(1, 10), hasReachedLatest: false);

        final segments = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments;
        expect(_segmentIds(segments), [
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        ]);
      });

      test('keeps newer loading enabled when the fetch has newer pages', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.insertAround(_identity, _segment(3, 4), hasReachedLatest: false);

        final activeSegment = container.read(
          conversationTimelineActiveSegmentProvider((
            identity: _identity,
            mode: const ConversationTimelineActiveSegmentMode.around(3),
          )),
        )!;
        expect(activeSegment.isLatestSlice, false);
        expect(activeSegment.canLoadAfter, true);
      });

      test(
        'marks the around segment as latest when the fetch reaches latest',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

          store.insertAround(_identity, _segment(3, 4), hasReachedLatest: true);

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [1, 2],
            [3, 4],
          ]);

          final activeSegment = container.read(
            conversationTimelineActiveSegmentProvider((
              identity: _identity,
              mode: const ConversationTimelineActiveSegmentMode.around(3),
            )),
          )!;
          expect(activeSegment.isLatestSlice, true);
          expect(activeSegment.canLoadAfter, false);
        },
      );
    });

    group('markReachedLatest', () {
      test('disables newer loading for the current tail', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3)]));

        store.markReachedLatest(_identity);

        final activeSegment = container.read(
          conversationTimelineActiveSegmentProvider((
            identity: _identity,
            mode: const ConversationTimelineActiveSegmentMode.around(2),
          )),
        )!;
        expect(activeSegment.isLatestSlice, true);
        expect(activeSegment.canLoadAfter, false);
      });
    });

    group('insertLatest', () {
      test('inserts the incoming segment into an empty scope', () {
        // Tests the base case: when nothing is cached yet, a latest fetch
        // becomes the first cached segment and is marked as the latest segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.insertLatestSegment(_identity, _segment(3, 4));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [3, 4],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test('splits a segment that overlaps the incoming range', () {
        // Tests that latest insertion uses the same replacement rules as
        // around-insertion while pointing the latest marker at the fresh slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 5)]));

        store.insertLatestSegment(_identity, _segment(3, 4));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2],
          [3, 4],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test('push new segment at end', () {
        // Tests that latest insertion uses the same replacement rules as
        // around-insertion while pointing the latest marker at the fresh slice.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 5)]));

        store.insertLatestSegment(_identity, _segment(7, 10));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2, 3, 4, 5],
          [7, 8, 9, 10],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test(
        'keeps discontiguous segments on both sides of the refreshed range',
        () {
          // Tests that untouched cached segments remain around the fresh latest
          // slice while the latest marker points at the inserted segment.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(_identity, _scope([_segment(1, 2), _segment(5, 6)]));

          store.insertLatestSegment(_identity, _segment(3, 4));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [1, 2],
            [3, 4],
          ]);
          expect(scope.hasReachedLatest, true);
        },
      );

      test('inserts between discontiguous cached segments without overlap', () {
        // Tests that a latest segment with no overlap is inserted in order and
        // becomes the explicitly tracked latest segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 2), _segment(7, 8)]));

        store.insertLatestSegment(_identity, _segment(4, 5));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2],
          [4, 5],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test('replaces overlapping ranges across multiple cached segments', () {
        // Tests that a latest segment can bridge multiple cached segments and
        // the latest marker follows the merged fresh range.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertLatestSegment(_identity, _segment(3, 4));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2],
          [3, 4],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test('replaces entire segments', () {
        // Tests that a latest insertion can replace the whole cached span and
        // still leaves the latest marker pointing at the single merged segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(_identity, _scope([_segment(1, 3), _segment(4, 6)]));

        store.insertLatestSegment(_identity, _segment(1, 10));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        ]);
        expect(scope.hasReachedLatest, true);
      });
    });

    group('newMessage', () {
      test(
        'ignores a server-backed message when no latest scope is loaded',
        () {
          // Tests the new-message merge contract: server-backed messages only
          // merge into an already loaded latest slice.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.newMessage(_identity, _message(7));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity];
          expect(scope, isNull);
        },
      );

      test(
        'ignores a server-backed message when only historical segments exist',
        () {
          // Tests that a created server message does not synthesize a latest
          // slice when the store is only holding historical ranges.
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope([_segment(1, 3), _segment(10, 12)], hasReachedLatest: false),
          );

          store.newMessage(_identity, _message(15));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [1, 2, 3],
            [10, 11, 12],
          ]);
          expect(scope.hasReachedLatest, false);
        },
      );

      test('appends the message to the current latest segment', () {
        // Tests the steady-state append path: a new newest message extends the
        // tracked latest tail instead of creating another segment.
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope([_segment(1, 3), _segment(10, 12)], hasReachedLatest: true),
        );

        store.newMessage(_identity, _message(13));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2, 3],
          [10, 11, 12, 13],
        ]);
        expect(scope.hasReachedLatest, true);
      });

      test('replaces an existing latest message with the same server id', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope([_segment(10, 12)], hasReachedLatest: true),
        );

        store.newMessage(_identity, _messageWithCustomText(11, 'updated-11'));

        final latestMessages = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .segments
            .last
            .orderedMessages;
        expect(latestMessages.map((message) => _messageText(message)), [
          'message-10',
          'updated-11',
          'message-12',
        ]);
      });

      test(
        'inserts a server-backed message into the middle of the latest segment',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope([
              ConversationTimelineCanonicalSegment(
                orderedMessages: [_message(10), _message(12)],
              ),
            ], hasReachedLatest: true),
          );

          store.newMessage(_identity, _message(11));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [10, 11, 12],
          ]);
        },
      );

      test(
        'inserts a server-backed message at the front of the latest segment when needed',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope([
              ConversationTimelineCanonicalSegment(
                orderedMessages: [_message(11), _message(12)],
              ),
            ], hasReachedLatest: true),
          );

          store.newMessage(_identity, _message(10));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [10, 11, 12],
          ]);
        },
      );
    });

    group('optimistic messages', () {
      test('stores optimistic messages alongside canonical segments', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope([_segment(1, 3)], hasReachedLatest: true),
        );

        store.newMessage(_identity, _optimisticMessage('client-4'));

        final scope = container.read(
          conversationTimelineMessageStoreProvider,
        )[_identity]!;
        expect(_segmentIds(scope.segments), [
          [1, 2, 3],
        ]);
        expect(
          scope.optimisticMessages.map((message) => message.clientGeneratedId),
          ['client-4'],
        );
      });

      test('replaces an existing optimistic message in place', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope(
            [_segment(1, 3)],
            hasReachedLatest: true,
            optimisticMessages: [_optimisticMessage('client-4')],
          ),
        );

        store.newMessage(
          _identity,
          _optimisticMessage('client-4', text: 'optimistic-updated'),
        );

        final optimisticMessages = container
            .read(conversationTimelineMessageStoreProvider)[_identity]!
            .optimisticMessages;
        expect(optimisticMessages, hasLength(1));
        expect(_messageText(optimisticMessages.single), 'optimistic-updated');
      });

      test(
        'returns latest slice with canonical tail plus optimistic messages',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [_segment(1, 3)],
              hasReachedLatest: true,
              optimisticMessages: [_optimisticMessage('client-4')],
            ),
          );

          final activeSegment = container.read(
            conversationTimelineActiveSegmentProvider((
              identity: _identity,
              mode: const ConversationTimelineActiveSegmentMode.latest(),
            )),
          )!;

          expect(
            activeSegment.orderedMessages.map((message) => message.stableKey),
            [
              'client:client-1',
              'client:client-2',
              'client:client-3',
              'client:client-4',
            ],
          );
          expect(activeSegment.isLatestSlice, true);
        },
      );

      test('does not inject optimistic messages into non-latest slices', () {
        final container = ProviderContainer();
        addTearDown(container.dispose);
        final store = container.read(
          conversationTimelineMessageStoreProvider.notifier,
        );

        store.putScope(
          _identity,
          _scope(
            [_segment(1, 3), _segment(10, 12)],
            hasReachedLatest: true,
            optimisticMessages: [_optimisticMessage('client-13')],
          ),
        );

        final activeSegment = container.read(
          conversationTimelineActiveSegmentProvider((
            identity: _identity,
            mode: const ConversationTimelineActiveSegmentMode.around(2),
          )),
        )!;

        expect(
          activeSegment.orderedMessages.map(
            (message) => message.serverMessageId,
          ),
          [1, 2, 3],
        );
      });

      test(
        'dedupes optimistic messages when canonical latest already contains the same clientGeneratedId',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [
                ConversationTimelineCanonicalSegment(
                  orderedMessages: [_message(1), _message(2), _message(3)],
                ),
              ],
              hasReachedLatest: true,
              optimisticMessages: [_optimisticMessage('client-3')],
            ),
          );

          final activeSegment = container.read(
            conversationTimelineActiveSegmentProvider((
              identity: _identity,
              mode: const ConversationTimelineActiveSegmentMode.latest(),
            )),
          )!;

          expect(
            activeSegment.orderedMessages.map(
              (message) => message.clientGeneratedId,
            ),
            ['client-1', 'client-2', 'client-3'],
          );
        },
      );

      test(
        'reconciles an optimistic message into canonical latest messages',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [_segment(1, 3)],
              hasReachedLatest: true,
              optimisticMessages: [_optimisticMessage('client-4')],
            ),
          );

          store.newMessage(_identity, _message(4));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [1, 2, 3, 4],
          ]);
          expect(scope.optimisticMessages, isEmpty);
        },
      );

      test(
        'reconciles multiple optimistic messages when server echoes arrive out of order',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [_segment(1, 3)],
              hasReachedLatest: true,
              optimisticMessages: [
                _optimisticMessage('client-4'),
                _optimisticMessage('client-5'),
              ],
            ),
          );

          store.newMessage(
            _identity,
            _messageWithText(5, 'client-5', 'second'),
          );
          store.newMessage(_identity, _messageWithText(4, 'client-4', 'first'));

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          expect(_segmentIds(scope.segments), [
            [1, 2, 3, 4, 5],
          ]);
          expect(scope.optimisticMessages, isEmpty);
        },
      );

      test(
        'keeps server-id order when another message arrives before local echo',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [_segment(1, 3)],
              hasReachedLatest: true,
              optimisticMessages: [_optimisticMessage('client-5')],
            ),
          );

          store.newMessage(
            _identity,
            _messageWithText(6, 'client-other-6', 'other user'),
          );
          store.newMessage(
            _identity,
            _messageWithText(5, 'client-5', 'local echo'),
          );

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          final activeSegment = container.read(
            conversationTimelineActiveSegmentProvider((
              identity: _identity,
              mode: const ConversationTimelineActiveSegmentMode.latest(),
            )),
          )!;
          expect(_segmentIds(scope.segments), [
            [1, 2, 3, 5, 6],
          ]);
          expect(scope.optimisticMessages, isEmpty);
          expect(
            activeSegment.orderedMessages.map(
              (message) => message.clientGeneratedId,
            ),
            ['client-1', 'client-2', 'client-3', 'client-5', 'client-other-6'],
          );
        },
      );

      test(
        'clears optimistic messages that are confirmed by a latest refresh',
        () {
          final container = ProviderContainer();
          addTearDown(container.dispose);
          final store = container.read(
            conversationTimelineMessageStoreProvider.notifier,
          );

          store.putScope(
            _identity,
            _scope(
              [_segment(1, 3)],
              hasReachedLatest: true,
              optimisticMessages: [_optimisticMessage('client-4')],
            ),
          );

          store.insertLatestSegment(
            _identity,
            ConversationTimelineCanonicalSegment(
              orderedMessages: [
                _message(2),
                _message(3),
                _messageWithText(4, 'client-4', 'confirmed by refresh'),
              ],
            ),
          );

          final scope = container.read(
            conversationTimelineMessageStoreProvider,
          )[_identity]!;
          final activeSegment = container.read(
            conversationTimelineActiveSegmentProvider((
              identity: _identity,
              mode: const ConversationTimelineActiveSegmentMode.latest(),
            )),
          )!;
          expect(scope.optimisticMessages, isEmpty);
          expect(
            activeSegment.orderedMessages.map(
              (message) => message.clientGeneratedId,
            ),
            ['client-2', 'client-3', 'client-4'],
          );
        },
      );
    });
  });
}

ConversationTimelineCanonicalSegment _segment(int start, int end) {
  return ConversationTimelineCanonicalSegment(
    orderedMessages: [for (var id = start; id <= end; id++) _message(id)],
  );
}

ConversationMessageV2 _message(int? serverMessageId) {
  return _messageWithText(
    serverMessageId,
    'client-${serverMessageId ?? 'missing'}',
    'message-$serverMessageId',
  );
}

ConversationMessageV2 _messageWithCustomText(
  int? serverMessageId,
  String text,
) {
  return _messageWithText(
    serverMessageId,
    'client-${serverMessageId ?? 'missing'}',
    text,
  );
}

ConversationMessageV2 _messageWithText(
  int? serverMessageId,
  String clientGeneratedId,
  String text,
) {
  return ConversationMessageV2(
    serverMessageId: serverMessageId,
    clientGeneratedId: clientGeneratedId,
    sender: _sender,
    content: TextMessageContent(text: text),
  );
}

ConversationMessageV2 _optimisticMessage(
  String clientGeneratedId, {
  String? text,
}) {
  return ConversationMessageV2(
    clientGeneratedId: clientGeneratedId,
    sender: _sender,
    content: TextMessageContent(text: text ?? 'optimistic-$clientGeneratedId'),
    deliveryState: ConversationDeliveryState.sending,
  );
}

String _messageText(ConversationMessageV2 message) {
  return switch (message.content) {
    TextMessageContent(:final text) => text,
    _ => throw StateError('Expected text content in test message'),
  };
}

List<List<int>> _segmentIds(
  List<ConversationTimelineCanonicalSegment> segments,
) {
  return [
    for (final segment in segments)
      [for (final message in segment.orderedMessages) message.serverMessageId!],
  ];
}

ConversationTimelineCanonicalScope _scope(
  List<ConversationTimelineCanonicalSegment> segments, {
  bool hasReachedLatest = false,
  bool hasReachedOldest = false,
  List<ConversationMessageV2> optimisticMessages = const [],
}) {
  return ConversationTimelineCanonicalScope(
    segments: segments,
    hasReachedLatest: hasReachedLatest,
    hasReachedOldest: hasReachedOldest,
    optimisticMessages: optimisticMessages,
  );
}
