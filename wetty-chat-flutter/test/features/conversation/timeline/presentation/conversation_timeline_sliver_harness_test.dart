import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('center-anchored conversation timeline harness', () {
    testWidgets(
      'keeps the visible row stable when older latest-slice history is inserted',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);
        final beforeMessages = _messages(11, 40);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: beforeMessages,
        );
        _jumpToScrollFraction(controller, 0.45);
        await tester.pump();

        final anchorId = _visibleRowClosestToCenter(
          tester,
          beforeMessages.map((message) => message.id),
        );
        final beforeDy = _rowViewportDy(tester, anchorId);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(1, 40),
        );
        await tester.pump();

        expect(_rowViewportDy(tester, anchorId), closeTo(beforeDy, 1));
      },
    );

    testWidgets(
      'keeps the visible row stable when older around-window messages are inserted',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);
        final beforeMessages = _messages(11, 20);
        final afterMessages = _messages(21, 30);

        await _pumpHarness(
          tester,
          controller: controller,
          anchor: 0.5,
          beforeMessages: beforeMessages,
          afterMessages: afterMessages,
        );
        _jumpToScrollFraction(controller, 0.45);
        await tester.pump();

        final anchorId = _visibleRowClosestToCenter(
          tester,
          [...beforeMessages, ...afterMessages].map((message) => message.id),
        );
        final beforeDy = _rowViewportDy(tester, anchorId);

        await _pumpHarness(
          tester,
          controller: controller,
          anchor: 0.5,
          beforeMessages: _messages(1, 20),
          afterMessages: afterMessages,
        );
        await tester.pump();

        expect(_rowViewportDy(tester, anchorId), closeTo(beforeDy, 1));
      },
    );

    testWidgets(
      'keeps the visible row stable when newer around-window messages are appended',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);
        final beforeMessages = _messages(1, 20);
        final afterMessages = _messages(21, 30);

        await _pumpHarness(
          tester,
          controller: controller,
          anchor: 0.5,
          beforeMessages: beforeMessages,
          afterMessages: afterMessages,
        );
        _jumpToScrollFraction(controller, 0.55);
        await tester.pump();

        final anchorId = _visibleRowClosestToCenter(
          tester,
          [...beforeMessages, ...afterMessages].map((message) => message.id),
        );
        final beforeDy = _rowViewportDy(tester, anchorId);

        await _pumpHarness(
          tester,
          controller: controller,
          anchor: 0.5,
          beforeMessages: beforeMessages,
          afterMessages: _messages(21, 40),
        );
        await tester.pump();

        expect(_rowViewportDy(tester, anchorId), closeTo(beforeDy, 1));
      },
    );

    testWidgets('keeps the latest row visible when the live-edge row grows', (
      tester,
    ) async {
      final controller = ScrollController();
      addTearDown(controller.dispose);

      await _pumpHarness(
        tester,
        controller: controller,
        beforeMessages: _messages(1, 20, height: 56),
      );
      controller.jumpTo(controller.position.maxScrollExtent);
      await tester.pump();

      await _pumpHarness(
        tester,
        controller: controller,
        beforeMessages: _messages(
          1,
          20,
          height: 56,
          heightsById: const {20: 140},
        ),
      );
      await tester.pump();

      final viewport = _viewportRect(tester);
      final latest = _rowRect(tester, 20);
      expect(latest.bottom, closeTo(viewport.bottom, 1));
      expect(latest.top < viewport.bottom, isTrue);
    });

    testWidgets(
      'keeps the latest row visible when a row above it grows at live edge',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(
            1,
            20,
            height: 56,
            heightsById: const {19: 140},
          ),
        );
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      'keeps the latest row visible when it grows while the viewport shrinks',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 600,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 360,
          beforeMessages: _messages(
            1,
            20,
            height: 56,
            heightsById: const {20: 140},
          ),
        );
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      'keeps the latest row visible when live-edge viewport height shrinks',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 600,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 360,
          beforeMessages: _messages(1, 20, height: 56),
        );
        await tester.pump();

        final viewport = _viewportRect(tester);
        final latest = _rowRect(tester, 20);
        expect(latest.bottom, closeTo(viewport.bottom, 1));
        expect(latest.top < viewport.bottom, isTrue);
      },
    );

    testWidgets(
      'keeps the latest row visible when keyboard shrink is followed by reaction growth',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 600,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 360,
          beforeMessages: _messages(1, 20, height: 56),
        );
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 360,
          beforeMessages: _messages(
            1,
            20,
            height: 56,
            heightsById: const {20: 140},
          ),
        );
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 20);
      },
    );

    testWidgets(
      'pins a newly appended latest message when already at live edge',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(1, 21, height: 56),
        );
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );

    testWidgets(
      'pins a newly appended latest message while the live-edge viewport shrinks',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 600,
          beforeMessages: _messages(1, 20, height: 56),
        );
        _jumpToLiveEdge(controller);
        await tester.pump();

        await _pumpHarness(
          tester,
          controller: controller,
          viewportHeight: 360,
          beforeMessages: _messages(1, 21, height: 56),
        );
        await tester.pump();

        _expectRowBottomPinnedToViewport(tester, 21);
      },
    );

    testWidgets(
      'keeps the reading row stable when the latest row mutates away from live edge',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);
        final beforeMessages = _messages(1, 40, height: 56);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: beforeMessages,
        );
        _jumpToScrollFraction(controller, 0.40);
        await tester.pump();

        final anchorId = _visibleRowClosestToCenter(
          tester,
          beforeMessages.map((message) => message.id).where((id) => id != 40),
        );
        final beforeDy = _rowViewportDy(tester, anchorId);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(
            1,
            40,
            height: 56,
            heightsById: const {40: 140},
          ),
        );
        await tester.pump();

        expect(_rowViewportDy(tester, anchorId), closeTo(beforeDy, 1));
      },
    );

    testWidgets(
      'keeps the reading row stable when another visible row above it grows',
      (tester) async {
        final controller = ScrollController();
        addTearDown(controller.dispose);
        final beforeMessages = _messages(1, 40, height: 56);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: beforeMessages,
        );
        _jumpToScrollFraction(controller, 0.40);
        await tester.pump();

        final ids = beforeMessages.map((message) => message.id);
        final anchorId = _visibleRowClosestToCenter(tester, ids);
        final mutatedId = _visibleRowAbove(tester, ids, anchorId);
        final beforeDy = _rowViewportDy(tester, anchorId);

        await _pumpHarness(
          tester,
          controller: controller,
          beforeMessages: _messages(
            1,
            40,
            height: 56,
            heightsById: {mutatedId: 140},
          ),
        );
        await tester.pump();

        expect(_rowViewportDy(tester, anchorId), closeTo(beforeDy, 1));
      },
    );
  });
}

const _harnessKey = ValueKey<String>('timeline-harness');
const _viewportKey = ValueKey<String>('timeline-viewport');

ValueKey<String> _rowKey(int id) => ValueKey<String>('message-row-$id');

class _HarnessMessage {
  const _HarnessMessage({required this.id, required this.height});

  final int id;
  final double height;
}

List<_HarnessMessage> _messages(
  int start,
  int end, {
  double height = 64,
  Map<int, double> heightsById = const <int, double>{},
}) {
  return [
    for (var id = start; id <= end; id++)
      _HarnessMessage(id: id, height: heightsById[id] ?? height),
  ];
}

Future<void> _pumpHarness(
  WidgetTester tester, {
  required ScrollController controller,
  required List<_HarnessMessage> beforeMessages,
  List<_HarnessMessage> afterMessages = const <_HarnessMessage>[],
  double anchor = 1.0,
  double viewportHeight = 480,
}) async {
  await tester.pumpWidget(
    Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: SizedBox(
          key: _viewportKey,
          width: 390,
          height: viewportHeight,
          child: _TimelineHarness(
            key: _harnessKey,
            controller: controller,
            beforeMessages: beforeMessages,
            afterMessages: afterMessages,
            anchor: anchor,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void _jumpToScrollFraction(ScrollController controller, double fraction) {
  final position = controller.position;
  final min = position.minScrollExtent;
  final max = position.maxScrollExtent;
  controller.jumpTo(min + ((max - min) * fraction));
}

void _jumpToLiveEdge(ScrollController controller) {
  controller.jumpTo(controller.position.maxScrollExtent);
}

void _expectRowBottomPinnedToViewport(WidgetTester tester, int id) {
  final viewport = _viewportRect(tester);
  final row = _rowRect(tester, id);
  expect(row.bottom, closeTo(viewport.bottom, 1));
  expect(row.top < viewport.bottom, isTrue);
}

int _visibleRowClosestToCenter(WidgetTester tester, Iterable<int> ids) {
  final viewport = _viewportRect(tester);
  final viewportCenter = viewport.center.dy;
  int? bestId;
  double? bestDistance;

  for (final id in ids) {
    final finder = find.byKey(_rowKey(id), skipOffstage: false);
    if (finder.evaluate().isEmpty) {
      continue;
    }
    final rect = tester.getRect(finder);
    if (!rect.overlaps(viewport)) {
      continue;
    }
    final distance = (rect.center.dy - viewportCenter).abs();
    if (bestDistance == null || distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }

  if (bestId == null) {
    throw StateError('No visible row found in ids: ${ids.join(', ')}');
  }
  return bestId;
}

int _visibleRowAbove(WidgetTester tester, Iterable<int> ids, int anchorId) {
  final viewport = _viewportRect(tester);
  final anchorTop = _rowRect(tester, anchorId).top;
  int? bestId;
  double? bestDistance;

  for (final id in ids) {
    if (id == anchorId) {
      continue;
    }
    final finder = find.byKey(_rowKey(id), skipOffstage: false);
    if (finder.evaluate().isEmpty) {
      continue;
    }
    final rect = tester.getRect(finder);
    if (!rect.overlaps(viewport) || rect.bottom > anchorTop) {
      continue;
    }
    final distance = anchorTop - rect.bottom;
    if (bestDistance == null || distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }

  if (bestId == null) {
    throw StateError('No visible row above anchor $anchorId');
  }
  return bestId;
}

double _rowViewportDy(WidgetTester tester, int id) {
  return _rowRect(tester, id).top - _viewportRect(tester).top;
}

Rect _rowRect(WidgetTester tester, int id) {
  return tester.getRect(find.byKey(_rowKey(id), skipOffstage: false));
}

Rect _viewportRect(WidgetTester tester) {
  return tester.getRect(find.byKey(_viewportKey));
}

class _TimelineHarness extends StatefulWidget {
  const _TimelineHarness({
    super.key,
    required this.controller,
    required this.beforeMessages,
    required this.afterMessages,
    required this.anchor,
  });

  final ScrollController controller;
  final List<_HarnessMessage> beforeMessages;
  final List<_HarnessMessage> afterMessages;
  final double anchor;

  @override
  State<_TimelineHarness> createState() => _TimelineHarnessState();
}

class _TimelineHarnessState extends State<_TimelineHarness> {
  final GlobalKey _centerSliverKey = GlobalKey();

  @override
  Widget build(BuildContext context) {
    final beforeMessages = widget.beforeMessages.reversed.toList(
      growable: false,
    );

    return CustomScrollView(
      controller: widget.controller,
      center: _centerSliverKey,
      anchor: widget.anchor,
      slivers: [
        if (beforeMessages.isNotEmpty) _messageSliver(beforeMessages),
        SliverToBoxAdapter(
          key: _centerSliverKey,
          child: const SizedBox.shrink(),
        ),
        if (widget.afterMessages.isNotEmpty)
          _messageSliver(widget.afterMessages),
      ],
    );
  }

  SliverList _messageSliver(List<_HarnessMessage> messages) {
    return SliverList.builder(
      itemCount: messages.length,
      itemBuilder: (context, index) {
        final message = messages[index];
        return SizedBox(
          key: _rowKey(message.id),
          height: message.height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: Color(0xFFE7EEF5 + (message.id % 5) * 0x0003060A),
              border: Border.all(color: const Color(0xFF8A9BAD)),
            ),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text('message ${message.id}'),
              ),
            ),
          ),
        );
      },
    );
  }
}
