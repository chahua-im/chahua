import 'dart:async';
import 'dart:developer';

import 'package:chahua/features/conversation/shared/application/conversation_canonical_message_store.dart';
import 'package:chahua/features/conversation/shared/data/conversation_timeline_v2_repository.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_active_segment.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/timeline/model/conversation_message_highlight.dart';
import 'package:chahua/features/conversation/timeline/model/message_visibility_window.dart';
import 'package:chahua/features/conversation/timeline/model/timeline_viewport_geometry.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

part 'conversation_timeline_view_model.freezed.dart';

// ============ Private Types ============
@immutable
/// Internal policy for splitting messages into before and after segments.
class _TimelineRenderSplitPolicy {
  const _TimelineRenderSplitPolicy.none()
    : serverWatermarkMessageId = null,
      localStableKeys = const <String>{},
      includeServerWatermarkInAfter = false;

  const _TimelineRenderSplitPolicy.fromMessageInclusive(
    this.serverWatermarkMessageId,
  ) : localStableKeys = const <String>{},
      includeServerWatermarkInAfter = true;

  const _TimelineRenderSplitPolicy.afterMessage(
    this.serverWatermarkMessageId, {
    this.localStableKeys = const <String>{},
  }) : includeServerWatermarkInAfter = false;

  final int? serverWatermarkMessageId;
  final Set<String> localStableKeys;
  final bool includeServerWatermarkInAfter;

  bool get hasBoundary =>
      serverWatermarkMessageId != null || localStableKeys.isNotEmpty;
}

// ============ Public Types ============

/// Commands issued by the timeline view model to the viewport controller.
enum ConversationTimelineViewportCommandKind {
  none,
  resetToCenterOrigin,
  scrollToBottom,
  settleToLiveEdge,
}

/// The preferred placement for the viewport command.
enum ConversationTimelineViewportPlacement { bottomPreferred, topPreferred }

/// The viewport state captured at the moment a local send starts.
enum ConversationLocalSendViewportIntent {
  latestNearBottom,
  latestAwayFromBottom,
  nonLatest,
}

/// A viewport command issued by the timeline view model to the viewport controller.
typedef ConversationTimelineViewportCommand = ({
  ConversationTimelineViewportCommandKind kind,
  ConversationTimelineViewportPlacement placement,
});

@freezed
/// The state of the timeline view model.
abstract class ConversationTimelineState with _$ConversationTimelineState {
  const factory ConversationTimelineState({
    @Default(<ConversationMessageV2>[])
    List<ConversationMessageV2> beforeMessages,
    @Default(<ConversationMessageV2>[])
    List<ConversationMessageV2> afterMessages,
    @Default(false) bool canLoadOlder,
    @Default(false) bool canLoadNewer,
    @Default(false) bool isLoadingOlder,
    @Default(false) bool isLoadingNewer,
    @Default(false) bool isResolvingJump,
    ConversationMessageHighlight? highlight,
    @Default((
      kind: ConversationTimelineViewportCommandKind.none,
      placement: ConversationTimelineViewportPlacement.bottomPreferred,
    ))
    ConversationTimelineViewportCommand viewportCommand,
    @Default(0) int viewportCommandGeneration,
    @Default(true) bool isBootstrapping,
  }) = _ConversationTimelineState;
}

/// Facts about the viewport reported by view to the view model.
@freezed
abstract class TimelineViewportFacts with _$TimelineViewportFacts {
  const factory TimelineViewportFacts({
    @Default(false) bool isNearTop,
    @Default(true) bool isNearBottom,
  }) = _TimelineViewportFacts;
}

// ============ View Model ============
class ConversationTimelineViewModel
    extends Notifier<ConversationTimelineState> {
  // Mostly temproary, we will remove these later
  static const int _initialLoadedWindowSize = 50;

  /// Identity (ChatID, threadID) for this VM
  final ConversationIdentity identity;

  /// Repository for this VM
  late ConversationTimelineV2Repository _repository;

  LaunchRequest? _initialLaunchRequest;

  /// Active segment containing the messages and some metadata
  ConversationTimelineActiveSegment? _activeSegment;

  int? _highlightedServerMessageId;
  int? _highlightFirstServerMessageIdAfter;
  int? _pendingHighlightGeneration;
  int _highlightGeneration = 0;
  ConversationMessageHighlight? _activeHighlight;
  Timer? _highlightClearTimer;
  bool _didRegisterDispose = false;
  TimelineViewportSnapshot? _latestViewportSnapshot;
  String? _lastRenderedTailStableKey;
  _TimelineRenderSplitPolicy _renderSplitPolicy =
      const _TimelineRenderSplitPolicy.none();
  bool _shouldCaptureLatestTailSplit = false;

  /// Generation of the viewport command, incremented on each issuance
  int _viewportCommandGeneration = 0;
  ConversationTimelineViewportCommand? _pendingViewportCommand;
  ConversationTimelineViewportCommand _lastViewportCommand = const (
    kind: ConversationTimelineViewportCommandKind.none,
    placement: ConversationTimelineViewportPlacement.bottomPreferred,
  );

  /// Make sure to use `_setActiveSegmentMode` instead of assigning directly
  /// to avoid forgetting `ref.invalidateSelf()`.
  ConversationTimelineActiveSegmentMode? _activeSegmentMode;

  ConversationTimelineViewModel(this.identity);

  @override
  ConversationTimelineState build() {
    if (!_didRegisterDispose) {
      ref.onDispose(_cancelHighlightClearTimer);
      _didRegisterDispose = true;
    }
    _repository = ref.read(conversationTimelineV2RepositoryProvider(identity));
    final activeSegmentMode = _activeSegmentMode;
    if (activeSegmentMode == null) {
      _activeSegment = null;
      return _loadingState();
    }

    _activeSegment = ref.watch(
      conversationTimelineActiveSegmentProvider((
        identity: identity,
        mode: activeSegmentMode,
      )),
    );
    log(
      'vm build: identity=$identity mode=${_modeLabel(activeSegmentMode)} '
      'hasSegment=${_activeSegment != null} '
      'pending=${_commandLabel(_pendingViewportCommand)} '
      'generation=$_viewportCommandGeneration',
      name: 'ConversationTimeline',
    );
    if (_activeSegment != null) {
      return _stateFromActiveSegment(
        _activeSegment!,
        isLoadingNewer: false,
        isLoadingOlder: false,
      );
    }
    return _loadingState();
  }

  void initialize(LaunchRequest launchRequest) {
    if (_initialLaunchRequest == launchRequest) {
      log(
        'initialize skipped: identity=$identity launch=$launchRequest',
        name: 'ConversationTimeline',
      );
      return;
    }
    _initialLaunchRequest = launchRequest;
    log(
      'initialize: identity=$identity launch=$launchRequest',
      name: 'ConversationTimeline',
    );

    switch (launchRequest) {
      case LatestLaunchRequest():
        jumpToLatest();
        break;
      case UnreadLaunchRequest(:final lastReadMessageId):
        jumpToUnread(lastReadMessageId);
        break;
      case MessageLaunchRequest(:final messageId, :final highlight):
        jumpToMessageServerId(messageId, highlight: highlight);
        break;
    }
  }

  void onViewportChanged(TimelineViewportSnapshot snapshot) {
    final previousSnapshot = _latestViewportSnapshot;
    _latestViewportSnapshot = snapshot;
    log(
      'vm viewport facts: identity=$identity mode=${_modeLabel(_activeSegmentMode)} '
      'snapshot=$snapshot bootstrapping=${state.isBootstrapping} '
      'canOlder=${state.canLoadOlder} canNewer=${state.canLoadNewer}',
      name: 'ConversationTimeline',
    );

    if (state.isBootstrapping) {
      return;
    }

    if (snapshot.isNearTop && state.canLoadOlder && !state.isLoadingOlder) {
      unawaited(loadOlder());
    }
    if (snapshot.isNearBottom && state.canLoadNewer && !state.isLoadingNewer) {
      unawaited(loadNewer());
    }
    final viewportExtentChanged =
        previousSnapshot != null &&
        (previousSnapshot.viewportExtent - snapshot.viewportExtent).abs() > 0.5;
    if (viewportExtentChanged &&
        (_activeSegmentMode?.isLatest ?? false) &&
        snapshot.isNearBottom &&
        !snapshot.viewportAtLiveEdge) {
      _publishViewportCommand(
        kind: ConversationTimelineViewportCommandKind.settleToLiveEdge,
        placement: ConversationTimelineViewportPlacement.bottomPreferred,
      );
    }
  }

  Future<void> toggleReaction(ConversationMessageV2 message, String emoji) {
    final messageId = message.serverMessageId;
    if (messageId == null ||
        message.content is StickerMessageContent ||
        message.isDeleted) {
      return Future<void>.value();
    }
    return _repository.toggleReaction(messageId: messageId, emoji: emoji);
  }

  Future<void> deleteMessage(ConversationMessageV2 message) {
    final messageId = message.serverMessageId;
    if (messageId == null || message.isDeleted) {
      return Future<void>.value();
    }
    return _repository.deleteMessage(messageId);
  }

  void reportMessageVisibilityWindow(MessageVisibilityWindow? window) {
    if (state.isBootstrapping || window == null) {
      return;
    }
    log('reportMessageVisibilityWindow: $window');
    _repository.markVisibleMessageRead(window.lastVisibleMessageId);
  }

  Future<void> jumpToLatest() async {
    log(
      'jumpToLatest: identity=$identity mode=${_modeLabel(_activeSegmentMode)} '
      'latestSnapshot=$_latestViewportSnapshot split=${_splitLabel(_renderSplitPolicy)}',
      name: 'ConversationTimeline',
    );
    unawaited(
      _repository.refreshLatestSegment(limit: _initialLoadedWindowSize),
    );
    _renderSplitPolicy = const _TimelineRenderSplitPolicy.none();
    _shouldCaptureLatestTailSplit = true;
    _setActiveSegmentMode(const ConversationTimelineActiveSegmentMode.latest());
    _issueViewportCommand(
      kind: ConversationTimelineViewportCommandKind.resetToCenterOrigin,
      placement: ConversationTimelineViewportPlacement.bottomPreferred,
    );
    _highlightedServerMessageId = null;
    _highlightFirstServerMessageIdAfter = null;
    _clearHighlightSignal();
  }

  Future<void> recoverLatestAfterRefresh() {
    return _repository.refreshLatestSegment(limit: _initialLoadedWindowSize);
  }

  /// Ensures the viewport is anchored to the tail of the latest segment.
  /// No-op when the user is already on the latest slice near the bottom —
  /// the realtime applier's auto-scroll will handle surfacing the echo.
  void followLatestTailIfNeeded() {
    final isFollowingTail =
        (_activeSegment?.isLatestSlice ?? false) &&
        (_latestViewportSnapshot?.isNearBottom ?? false);
    log(
      'followLatestTailIfNeeded: identity=$identity '
      'mode=${_modeLabel(_activeSegmentMode)} '
      'activeLatest=${_activeSegment?.isLatestSlice} '
      'latestSnapshot=$_latestViewportSnapshot isFollowingTail=$isFollowingTail',
      name: 'ConversationTimeline',
    );
    if (isFollowingTail) {
      return;
    }
    log(
      'followLatestTailIfNeeded: not following tail, will jump to latest',
      name: 'ConversationTimeline',
    );
    unawaited(jumpToLatest());
  }

  ConversationLocalSendViewportIntent captureLocalSendViewportIntent() {
    final isLatestSlice = _activeSegment?.isLatestSlice ?? false;
    final isNearBottom = _latestViewportSnapshot?.isNearBottom ?? false;
    final intent = !isLatestSlice
        ? ConversationLocalSendViewportIntent.nonLatest
        : isNearBottom
        ? ConversationLocalSendViewportIntent.latestNearBottom
        : ConversationLocalSendViewportIntent.latestAwayFromBottom;
    log(
      'captureLocalSendViewportIntent: identity=$identity '
      'mode=${_modeLabel(_activeSegmentMode)} activeLatest=$isLatestSlice '
      'latestSnapshot=$_latestViewportSnapshot intent=${intent.name}',
      name: 'ConversationTimeline',
    );
    return intent;
  }

  void applyLocalSendViewportIntent(
    ConversationLocalSendViewportIntent intent,
  ) {
    log(
      'applyLocalSendViewportIntent: identity=$identity '
      'mode=${_modeLabel(_activeSegmentMode)} intent=${intent.name}',
      name: 'ConversationTimeline',
    );
    switch (intent) {
      case ConversationLocalSendViewportIntent.latestNearBottom:
        _issueViewportCommand(
          kind: ConversationTimelineViewportCommandKind.scrollToBottom,
          placement: ConversationTimelineViewportPlacement.bottomPreferred,
        );
        ref.invalidateSelf();
        break;
      case ConversationLocalSendViewportIntent.latestAwayFromBottom:
        _highlightedServerMessageId = null;
        _highlightFirstServerMessageIdAfter = null;
        _clearHighlightSignal();
        _renderSplitPolicy = const _TimelineRenderSplitPolicy.none();
        _shouldCaptureLatestTailSplit = true;
        _issueViewportCommand(
          kind: ConversationTimelineViewportCommandKind.resetToCenterOrigin,
          placement: ConversationTimelineViewportPlacement.bottomPreferred,
        );
        ref.invalidateSelf();
        break;
      case ConversationLocalSendViewportIntent.nonLatest:
        unawaited(jumpToLatest());
        break;
    }
  }

  Future<void> jumpToMessageServerId(
    int messageId, {
    bool highlight = true,
  }) async {
    unawaited(
      _repository.refreshAroundServerMessageId(
        messageId,
        limit: _initialLoadedWindowSize,
      ),
    );

    final aroundMode = ConversationTimelineActiveSegmentMode.around(messageId);
    _setActiveSegmentMode(aroundMode);
    _highlightedServerMessageId = highlight ? messageId : null;
    _highlightFirstServerMessageIdAfter = null;
    _pendingHighlightGeneration = highlight ? ++_highlightGeneration : null;
    if (!highlight) {
      _clearHighlightSignal();
    }
    _renderSplitPolicy = _TimelineRenderSplitPolicy.fromMessageInclusive(
      messageId,
    );
    _issueViewportCommand(
      kind: ConversationTimelineViewportCommandKind.resetToCenterOrigin,
      placement: ConversationTimelineViewportPlacement.topPreferred,
    );
  }

  void jumpToUnread(int lastReadMessageId) {
    unawaited(
      _repository.refreshAroundServerMessageId(
        lastReadMessageId,
        limit: _initialLoadedWindowSize,
      ),
    );

    final aroundMode = ConversationTimelineActiveSegmentMode.around(
      lastReadMessageId,
    );
    _setActiveSegmentMode(aroundMode);
    _highlightedServerMessageId = null;
    _highlightFirstServerMessageIdAfter = lastReadMessageId;
    _pendingHighlightGeneration = ++_highlightGeneration;
    _renderSplitPolicy = _TimelineRenderSplitPolicy.afterMessage(
      lastReadMessageId,
    );
    _issueViewportCommand(
      kind: ConversationTimelineViewportCommandKind.resetToCenterOrigin,
      placement: ConversationTimelineViewportPlacement.topPreferred,
    );
  }

  Future<void> loadOlder() async {
    if (state.isLoadingOlder || state.isBootstrapping || !state.canLoadOlder) {
      return;
    }

    if (_activeSegment == null || _activeSegment!.orderedMessages.isEmpty) {
      return;
    }

    final anchorServerMessageId = _firstServerMessageId(
      _activeSegment!.orderedMessages,
    );
    if (anchorServerMessageId == null) {
      return;
    }

    state = state.copyWith(isLoadingOlder: true);

    try {
      await _repository.loadOlderBeforeAnchor(anchorServerMessageId, limit: 20);
    } finally {
      state = state.copyWith(isLoadingOlder: false);
    }
  }

  Future<void> loadNewer() async {
    if (state.isLoadingNewer || state.isBootstrapping || !state.canLoadNewer) {
      return;
    }

    if (_activeSegment == null || _activeSegment!.orderedMessages.isEmpty) {
      return;
    }
    final anchorServerMessageId = _lastServerMessageId(
      _activeSegment!.orderedMessages,
    );
    if (anchorServerMessageId == null) {
      return;
    }

    state = state.copyWith(isLoadingNewer: true);

    try {
      await _repository.loadNewerAfterAnchor(anchorServerMessageId, limit: 20);
    } finally {
      state = state.copyWith(isLoadingNewer: false);
    }
  }

  ConversationTimelineState _stateFromActiveSegment(
    ConversationTimelineActiveSegment segment, {
    bool? isLoadingOlder,
    bool? isLoadingNewer,
  }) {
    if (_shouldCaptureLatestTailSplit) {
      _captureLatestTailSplit(segment);
      _shouldCaptureLatestTailSplit = false;
    } else {
      _promoteLocalSplitAnchorsIfConfirmed(segment.orderedMessages);
    }

    final beforeMessages = <ConversationMessageV2>[];
    final afterMessages = <ConversationMessageV2>[];
    if (!_renderSplitPolicy.hasBoundary) {
      beforeMessages.addAll(segment.orderedMessages);
    } else {
      _splitMessages(
        segment.orderedMessages,
        policy: _renderSplitPolicy,
        beforeMessages: beforeMessages,
        afterMessages: afterMessages,
      );
    }
    String? highlightedStableKey;
    if (_highlightedServerMessageId != null) {
      for (final message in segment.orderedMessages) {
        if (message.serverMessageId == _highlightedServerMessageId) {
          highlightedStableKey = message.stableKey;
          break;
        }
      }
    } else if (_highlightFirstServerMessageIdAfter case final readBoundary?) {
      for (final message in segment.orderedMessages) {
        final serverMessageId = message.serverMessageId;
        if (serverMessageId != null && serverMessageId > readBoundary) {
          highlightedStableKey = message.stableKey;
          break;
        }
      }
    }
    _syncHighlightSignal(highlightedStableKey);
    final currentTailStableKey = segment.orderedMessages.isEmpty
        ? null
        : segment.orderedMessages.last.stableKey;
    final shouldSettleLiveEdge =
        (_activeSegmentMode?.isLatest ?? false) &&
        segment.isLatestSlice &&
        (_latestViewportSnapshot?.isNearBottom ?? false) &&
        _lastRenderedTailStableKey != null &&
        currentTailStableKey != null;
    log(
      'stateFromSegment: identity=$identity mode=${_modeLabel(_activeSegmentMode)} '
      'segmentLatest=${segment.isLatestSlice} count=${segment.orderedMessages.length} '
      'split=${_splitLabel(_renderSplitPolicy)} '
      'before=${beforeMessages.length} after=${afterMessages.length} '
      'lastTail=$_lastRenderedTailStableKey currentTail=$currentTailStableKey '
      'latestSnapshot=$_latestViewportSnapshot shouldSettleLiveEdge=$shouldSettleLiveEdge '
      'pending=${_commandLabel(_pendingViewportCommand)} generation=$_viewportCommandGeneration',
      name: 'ConversationTimeline',
    );
    if (shouldSettleLiveEdge) {
      _issueViewportCommand(
        kind: ConversationTimelineViewportCommandKind.settleToLiveEdge,
        placement: ConversationTimelineViewportPlacement.bottomPreferred,
      );
    }
    final viewportCommand = _takePendingViewportCommand(
      hasMessages: segment.orderedMessages.isNotEmpty,
    );
    _lastRenderedTailStableKey = currentTailStableKey;

    return ConversationTimelineState(
      beforeMessages: beforeMessages,
      afterMessages: afterMessages,
      canLoadOlder: segment.canLoadBefore,
      canLoadNewer: segment.canLoadAfter,
      isLoadingOlder: isLoadingOlder ?? state.isLoadingOlder,
      isLoadingNewer: isLoadingNewer ?? state.isLoadingNewer,
      isResolvingJump: false,
      highlight: _activeHighlight,
      viewportCommand: viewportCommand?.command ?? _lastViewportCommand,
      viewportCommandGeneration:
          viewportCommand?.generation ?? _viewportCommandGeneration,
      isBootstrapping: false,
    );
  }

  void _syncHighlightSignal(String? highlightedStableKey) {
    if (highlightedStableKey == null) {
      return;
    }
    final pendingGeneration = _pendingHighlightGeneration;
    final activeHighlight = _activeHighlight;
    if (pendingGeneration == null) {
      if (activeHighlight?.stableKey != highlightedStableKey) {
        _clearHighlightSignal();
      }
      return;
    }
    if (activeHighlight?.stableKey == highlightedStableKey &&
        activeHighlight?.generation == pendingGeneration) {
      return;
    }
    _activeHighlight = ConversationMessageHighlight(
      stableKey: highlightedStableKey,
      generation: pendingGeneration,
      startedAt: DateTime.now(),
    );
    _scheduleHighlightClear(pendingGeneration);
  }

  void _scheduleHighlightClear(int generation) {
    _highlightClearTimer?.cancel();
    _highlightClearTimer = Timer(
      ConversationMessageHighlight.totalDuration,
      () {
        if (_activeHighlight?.generation != generation) {
          return;
        }
        _clearHighlightSignal();
        ref.invalidateSelf();
      },
    );
  }

  void _clearHighlightSignal() {
    _highlightClearTimer?.cancel();
    _highlightClearTimer = null;
    _pendingHighlightGeneration = null;
    _activeHighlight = null;
  }

  void _cancelHighlightClearTimer() {
    _highlightClearTimer?.cancel();
    _highlightClearTimer = null;
  }

  ({ConversationTimelineViewportCommand command, int generation})?
  _takePendingViewportCommand({required bool hasMessages}) {
    // We can execute a pending viewport command if we have messages.
    if ((_pendingViewportCommand != null) && hasMessages) {
      final command = _pendingViewportCommand!;
      _pendingViewportCommand = null;
      final generation = ++_viewportCommandGeneration;
      log(
        'takePendingViewportCommand: identity=$identity '
        'command=${_commandLabel(command)} generation=$generation',
        name: 'ConversationTimeline',
      );
      return (command: command, generation: generation);
    }
    if (_pendingViewportCommand != null) {
      log(
        'takePendingViewportCommand blocked: identity=$identity '
        'hasMessages=$hasMessages pending=${_commandLabel(_pendingViewportCommand)} '
        'generation=$_viewportCommandGeneration',
        name: 'ConversationTimeline',
      );
    }
    return null;
  }

  int? _firstServerMessageId(List<ConversationMessageV2> messages) {
    for (final message in messages) {
      final serverMessageId = message.serverMessageId;
      if (serverMessageId != null) {
        return serverMessageId;
      }
    }
    return null;
  }

  int? _lastServerMessageId(List<ConversationMessageV2> messages) {
    for (final message in messages.reversed) {
      final serverMessageId = message.serverMessageId;
      if (serverMessageId != null) {
        return serverMessageId;
      }
    }
    return null;
  }

  /// Creates the compact command record consumed by the timeline widget.
  ConversationTimelineViewportCommand _viewportCommand({
    required ConversationTimelineViewportCommandKind kind,
    required ConversationTimelineViewportPlacement placement,
  }) {
    return (kind: kind, placement: placement);
  }

  /// Publishes an immediately executable viewport effect from a viewport event.
  void _publishViewportCommand({
    required ConversationTimelineViewportCommandKind kind,
    required ConversationTimelineViewportPlacement placement,
  }) {
    final command = _viewportCommand(kind: kind, placement: placement);
    _lastViewportCommand = command;
    ++_viewportCommandGeneration;
    log(
      'publishViewportCommand: identity=$identity '
      'command=${_commandLabel(command)} generation=$_viewportCommandGeneration',
      name: 'ConversationTimeline',
    );
    state = state.copyWith(
      viewportCommand: command,
      viewportCommandGeneration: _viewportCommandGeneration,
    );
  }

  /// Queues a viewport effect to be delivered with the next rendered state.
  void _issueViewportCommand({
    required ConversationTimelineViewportCommandKind kind,
    required ConversationTimelineViewportPlacement placement,
  }) {
    final command = _viewportCommand(kind: kind, placement: placement);
    log(
      'issueViewportCommand: identity=$identity command=${_commandLabel(command)} '
      'previousPending=${_commandLabel(_pendingViewportCommand)} '
      'previousLast=${_commandLabel(_lastViewportCommand)} '
      'generationBefore=$_viewportCommandGeneration',
      name: 'ConversationTimeline',
    );
    _pendingViewportCommand = command;
    _lastViewportCommand = command;
    ++_viewportCommandGeneration;
    log(
      'issueViewportCommand queued: identity=$identity '
      'command=${_commandLabel(command)} generation=$_viewportCommandGeneration',
      name: 'ConversationTimeline',
    );
  }

  ConversationTimelineState _loadingState({bool isBootstrapping = true}) {
    return ConversationTimelineState(
      viewportCommand: _viewportCommand(
        kind: ConversationTimelineViewportCommandKind.none,
        placement: ConversationTimelineViewportPlacement.bottomPreferred,
      ),
      viewportCommandGeneration: _viewportCommandGeneration,
      isBootstrapping: isBootstrapping,
    );
  }

  /// Updates the active segment selection and invalidates this notifier so
  /// build() re-subscribes to the matching active-segment provider. Command
  /// paths should always use this helper instead of assigning `_activeSegmentMode`
  /// directly, to avoid forgetting `ref.invalidateSelf()`.
  void _setActiveSegmentMode(ConversationTimelineActiveSegmentMode mode) {
    _activeSegmentMode = mode;
    ref.invalidateSelf();
  }

  void _captureLatestTailSplit(ConversationTimelineActiveSegment segment) {
    if (_activeSegmentMode?.isLatest != true) {
      return;
    }

    if (segment.orderedMessages.isEmpty) {
      _renderSplitPolicy = const _TimelineRenderSplitPolicy.none();
      return;
    }

    final tailMessage = segment.orderedMessages.last;
    final tailServerMessageId = _lastServerMessageId(segment.orderedMessages);
    final localStableKeys = tailMessage.serverMessageId == null
        ? <String>{tailMessage.stableKey}
        : const <String>{};
    _renderSplitPolicy = _TimelineRenderSplitPolicy.afterMessage(
      tailServerMessageId,
      localStableKeys: localStableKeys,
    );
    log(
      'captureLatestTailSplit: identity=$identity '
      'tailServerId=$tailServerMessageId localKeys=$localStableKeys',
      name: 'ConversationTimeline',
    );
  }

  void _promoteLocalSplitAnchorsIfConfirmed(
    List<ConversationMessageV2> messages,
  ) {
    if (_renderSplitPolicy.localStableKeys.isEmpty) {
      return;
    }

    var serverWatermark = _renderSplitPolicy.serverWatermarkMessageId;
    final remainingLocalStableKeys = <String>{};

    for (final localStableKey in _renderSplitPolicy.localStableKeys) {
      ConversationMessageV2? anchoredMessage;
      for (final message in messages) {
        if (message.stableKey == localStableKey) {
          anchoredMessage = message;
          break;
        }
      }

      if (anchoredMessage == null) {
        continue;
      }

      final serverMessageId = anchoredMessage.serverMessageId;
      if (serverMessageId == null) {
        remainingLocalStableKeys.add(localStableKey);
        continue;
      }

      serverWatermark = serverWatermark == null
          ? serverMessageId
          : serverWatermark > serverMessageId
          ? serverWatermark
          : serverMessageId;
      log(
        'promoteLocalSplitAnchor: identity=$identity '
        'stableKey=$localStableKey serverId=$serverMessageId '
        'watermark=$serverWatermark',
        name: 'ConversationTimeline',
      );
    }

    _renderSplitPolicy = _TimelineRenderSplitPolicy.afterMessage(
      serverWatermark,
      localStableKeys: Set<String>.unmodifiable(remainingLocalStableKeys),
    );
  }

  void _splitMessages(
    List<ConversationMessageV2> messages, {
    required _TimelineRenderSplitPolicy policy,
    required List<ConversationMessageV2> beforeMessages,
    required List<ConversationMessageV2> afterMessages,
  }) {
    if (!policy.hasBoundary) {
      beforeMessages.addAll(messages);
      return;
    }

    for (final message in messages) {
      if (policy.localStableKeys.contains(message.stableKey)) {
        beforeMessages.add(message);
        continue;
      }

      final serverWatermarkMessageId = policy.serverWatermarkMessageId;
      final serverMessageId = message.serverMessageId;
      if (serverWatermarkMessageId == null || serverMessageId == null) {
        afterMessages.add(message);
        continue;
      }

      final belongsAfter = policy.includeServerWatermarkInAfter
          ? serverMessageId >= serverWatermarkMessageId
          : serverMessageId > serverWatermarkMessageId;
      if (belongsAfter) {
        afterMessages.add(message);
      } else {
        beforeMessages.add(message);
      }
    }
  }

  String _modeLabel(ConversationTimelineActiveSegmentMode? mode) {
    if (mode == null) {
      return 'none';
    }
    final target = mode.targetServerMessageId;
    return target == null ? 'latest' : 'around($target)';
  }

  String _splitLabel(_TimelineRenderSplitPolicy policy) {
    final anchor = policy.serverWatermarkMessageId;
    if (!policy.hasBoundary) {
      return 'none';
    }
    final prefix = policy.includeServerWatermarkInAfter
        ? 'fromInclusive($anchor)'
        : 'after($anchor)';
    if (policy.localStableKeys.isEmpty) {
      return prefix;
    }
    return '$prefix+local(${policy.localStableKeys.length})';
  }

  String _commandLabel(ConversationTimelineViewportCommand? command) {
    if (command == null) {
      return 'null';
    }
    return '${command.kind.name}/${command.placement.name}';
  }
}

final conversationTimelineViewModelProvider =
    NotifierProvider.family<
      ConversationTimelineViewModel,
      ConversationTimelineState,
      ConversationIdentity
    >(ConversationTimelineViewModel.new, isAutoDispose: true);
