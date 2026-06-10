import 'dart:developer';

import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_active_segment.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_timeline_v2_canonical_scope.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

typedef ConversationTimelineMessageStoreState =
    Map<ConversationIdentity, ConversationTimelineCanonicalScope>;

class ConversationTimelineMessageStore
    extends Notifier<ConversationTimelineMessageStoreState> {
  @override
  ConversationTimelineMessageStoreState build() {
    return <ConversationIdentity, ConversationTimelineCanonicalScope>{};
  }

  ConversationTimelineCanonicalScope? scopeFor(ConversationIdentity identity) {
    return state[identity];
  }

  ConversationMessageV2? messageForServerMessageId(
    ConversationIdentity identity,
    int serverMessageId,
  ) {
    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return null;
    }

    for (final segment in existingScope.segments) {
      for (final message in segment.orderedMessages) {
        if (message.serverMessageId == serverMessageId) {
          return message;
        }
      }
    }

    for (final message in existingScope.optimisticMessages) {
      if (message.serverMessageId == serverMessageId) {
        return message;
      }
    }

    return null;
  }

  ConversationMessageV2? messageForClientGeneratedId(
    ConversationIdentity identity,
    String clientGeneratedId,
  ) {
    final existingScope = scopeFor(identity);
    if (existingScope == null || clientGeneratedId.isEmpty) {
      return null;
    }

    for (final message in existingScope.optimisticMessages) {
      if (message.clientGeneratedId == clientGeneratedId) {
        return message;
      }
    }

    for (final segment in existingScope.segments) {
      for (final message in segment.orderedMessages) {
        if (message.clientGeneratedId == clientGeneratedId) {
          return message;
        }
      }
    }

    return null;
  }

  void putScope(
    ConversationIdentity identity,
    ConversationTimelineCanonicalScope scope,
  ) {
    state = <ConversationIdentity, ConversationTimelineCanonicalScope>{
      ...state,
      identity: scope,
    };
  }

  void markReachedOldest(ConversationIdentity identity) {
    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return;
    }
    putScope(identity, existingScope.copyWith(hasReachedOldest: true));
  }

  void markReachedLatest(ConversationIdentity identity) {
    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return;
    }
    putScope(identity, existingScope.copyWith(hasReachedLatest: true));
  }

  void insertBeforeAnchor(
    ConversationIdentity identity,
    int anchorServerMessageId,
    ConversationTimelineCanonicalSegment segment,
  ) {
    assert(
      segment.lastServerMessageId < anchorServerMessageId,
      'insertBeforeAnchor requires the incoming segment to be strictly before the anchor',
    );
    final existingScope = scopeFor(identity);
    final segments = _normalizeBeforeAnchorSegments(
      existingScope?.segments ?? const <ConversationTimelineCanonicalSegment>[],
      incoming: segment,
      anchorServerMessageId: anchorServerMessageId,
    );

    putScope(
      identity,
      (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
        segments: segments,
      ),
    );
  }

  void insertAfterAnchor(
    ConversationIdentity identity,
    int anchorServerMessageId,
    ConversationTimelineCanonicalSegment segment, {
    required bool hasReachedLatest,
  }) {
    assert(
      segment.firstServerMessageId > anchorServerMessageId,
      'insertAfterAnchor requires the incoming segment to be strictly after the anchor',
    );
    final existingScope = scopeFor(identity);
    final normalizedSegments = _normalizeAfterAnchorSegments(
      existingScope?.segments ?? const <ConversationTimelineCanonicalSegment>[],
      incoming: segment,
      anchorServerMessageId: anchorServerMessageId,
    );
    final segments = hasReachedLatest
        ? normalizedSegments
              .where(
                (item) => !item.startsAfterServerMessageId(
                  segment.lastServerMessageId,
                ),
              )
              .toList(growable: false)
        : normalizedSegments;

    putScope(
      identity,
      (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
        segments: segments,
        hasReachedLatest:
            hasReachedLatest || (existingScope?.hasReachedLatest ?? false),
      ),
    );
  }

  void insertAround(
    ConversationIdentity identity,
    ConversationTimelineCanonicalSegment segment, {
    required bool hasReachedLatest,
  }) {
    final existingScope = scopeFor(identity);
    final existingSegments =
        existingScope?.segments ??
        const <ConversationTimelineCanonicalSegment>[];
    final segments = hasReachedLatest
        ? _normalizeLatestSegments(existingSegments, incoming: segment)
        : _normalizeAroundSegments(existingSegments, incoming: segment);

    putScope(
      identity,
      (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
        segments: segments,
        hasReachedLatest:
            hasReachedLatest || (existingScope?.hasReachedLatest ?? false),
      ),
    );
  }

  /// Inserts a new segment at the end as the latest segment.
  void insertLatestSegment(
    ConversationIdentity identity,
    ConversationTimelineCanonicalSegment segment,
  ) {
    final existingScope = scopeFor(identity);
    log(
      'store insertLatest: identity=$identity incoming=${segment.orderedMessages.length} '
      'existingSegments=${existingScope?.segments.length ?? 0} '
      'existingOptimistic=${existingScope?.optimisticMessages.length ?? 0}',
      name: 'ConversationTimeline',
    );
    final optimisticMessages =
        existingScope?.optimisticMessages ?? const <ConversationMessageV2>[];
    final segmentWithLocalOrder = _preserveLocalSendOrder(
      segment,
      optimisticMessages,
    );
    final segments = _normalizeLatestSegments(
      existingScope?.segments ?? const <ConversationTimelineCanonicalSegment>[],
      incoming: segmentWithLocalOrder,
    );

    putScope(
      identity,
      (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
        segments: segments,
        optimisticMessages: _withoutConfirmedOptimisticMessages(
          optimisticMessages,
          segmentWithLocalOrder,
        ),
        hasReachedLatest: true,
      ),
    );
  }

  void newMessage(
    ConversationIdentity identity,
    ConversationMessageV2 message,
  ) {
    if (message.serverMessageId == null) {
      _newOptimisticMessage(identity, message);
      return;
    }
    _newServerBackedMessage(identity, message);
  }

  void _newServerBackedMessage(
    ConversationIdentity identity,
    ConversationMessageV2 message,
  ) {
    final existingScope = scopeFor(identity);
    log(
      'store newServerBackedMessage: identity=$identity '
      'serverId=${message.serverMessageId} clientId=${message.clientGeneratedId} '
      'hasScope=${existingScope != null} '
      'hasLatest=${existingScope?.hasReachedLatest} '
      'segments=${existingScope?.segments.length ?? 0} '
      'optimistic=${existingScope?.optimisticMessages.length ?? 0}',
      name: 'ConversationTimeline',
    );
    if (existingScope == null || !existingScope.hasReachedLatest) {
      return;
    }

    ConversationMessageV2? matchingOptimisticMessage;
    final optimisticMessages = existingScope.optimisticMessages
        .where((item) {
          final isMatch = item.clientGeneratedId == message.clientGeneratedId;
          if (isMatch) {
            matchingOptimisticMessage = item;
          }
          return !isMatch;
        })
        .toList(growable: false);
    final serverBackedMessage = matchingOptimisticMessage == null
        ? message
        : message.copyWith(
            localSendOrder: matchingOptimisticMessage!.localSendOrder,
          );
    final latestSegment = existingScope.segments.isEmpty
        ? null
        : existingScope.segments.last;
    if (latestSegment == null) {
      putScope(
        identity,
        existingScope.copyWith(
          optimisticMessages: optimisticMessages,
          segments: [
            ConversationTimelineCanonicalSegment(
              orderedMessages: [serverBackedMessage],
            ),
          ],
          hasReachedLatest: true,
        ),
      );
      return;
    }

    final updatedLatestMessages = _mergeLatestMessages(
      latestSegment.orderedMessages,
      serverBackedMessage,
    );

    putScope(
      identity,
      existingScope.copyWith(
        optimisticMessages: optimisticMessages,
        segments: [
          ...existingScope.segments.take(existingScope.segments.length - 1),
          ConversationTimelineCanonicalSegment(
            orderedMessages: updatedLatestMessages,
          ),
        ],
        hasReachedLatest: true,
      ),
    );
    log(
      'store newServerBackedMessage applied: identity=$identity '
      'serverId=${message.serverMessageId} '
      'remainingOptimistic=${optimisticMessages.length} '
      'latestCount=${updatedLatestMessages.length}',
      name: 'ConversationTimeline',
    );
  }

  void _newOptimisticMessage(
    ConversationIdentity identity,
    ConversationMessageV2 message,
  ) {
    assert(
      message.serverMessageId == null,
      '_newOptimisticMessage requires a local-only message',
    );

    final existingScope = scopeFor(identity);
    final optimisticMessages =
        (existingScope?.optimisticMessages ?? const <ConversationMessageV2>[])
            .toList(growable: true);
    log(
      'store newOptimisticMessage: identity=$identity '
      'clientId=${message.clientGeneratedId} '
      'hasLatestBefore=${existingScope?.hasReachedLatest} '
      'segmentsBefore=${existingScope?.segments.length ?? 0} '
      'optimisticBefore=${optimisticMessages.length}',
      name: 'ConversationTimeline',
    );

    for (var index = 0; index < optimisticMessages.length; index++) {
      if (optimisticMessages[index].clientGeneratedId !=
          message.clientGeneratedId) {
        continue;
      }
      optimisticMessages[index] = message;
      putScope(
        identity,
        (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
          hasReachedLatest: true,
          optimisticMessages: optimisticMessages.toList(growable: false),
        ),
      );
      log(
        'store newOptimisticMessage replaced: identity=$identity '
        'clientId=${message.clientGeneratedId} '
        'optimisticAfter=${optimisticMessages.length}',
        name: 'ConversationTimeline',
      );
      return;
    }

    optimisticMessages.add(message);

    putScope(
      identity,
      (existingScope ?? const ConversationTimelineCanonicalScope()).copyWith(
        hasReachedLatest: true,
        optimisticMessages: optimisticMessages.toList(growable: false),
      ),
    );
    log(
      'store newOptimisticMessage appended: identity=$identity '
      'clientId=${message.clientGeneratedId} '
      'hasLatestAfter=true '
      'segmentsAfter=${existingScope?.segments.length ?? 0} '
      'optimisticAfter=${optimisticMessages.length}',
      name: 'ConversationTimeline',
    );
  }

  bool updateMessage(
    ConversationIdentity identity,
    ConversationMessageV2 message,
  ) {
    final serverMessageId = message.serverMessageId;
    assert(
      serverMessageId != null,
      'updateMessage requires a server-backed message',
    );

    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return false;
    }

    var replaced = false;
    final segments = existingScope.segments
        .map((segment) {
          var segmentReplaced = false;
          final updatedMessages = segment.orderedMessages
              .map((existingMessage) {
                if (existingMessage.serverMessageId != serverMessageId) {
                  return existingMessage;
                }
                replaced = true;
                segmentReplaced = true;
                return message;
              })
              .toList(growable: false);
          return segmentReplaced
              ? ConversationTimelineCanonicalSegment(
                  orderedMessages: updatedMessages,
                )
              : segment;
        })
        .toList(growable: false);

    if (!replaced) {
      return false;
    }

    putScope(identity, existingScope.copyWith(segments: segments));
    return true;
  }

  bool updateLocalMessage(
    ConversationIdentity identity,
    ConversationMessageV2 message,
  ) {
    assert(
      message.serverMessageId == null,
      'updateLocalMessage requires a local-only message',
    );

    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return false;
    }

    var replaced = false;
    final optimisticMessages = existingScope.optimisticMessages
        .map((item) {
          if (item.clientGeneratedId != message.clientGeneratedId) {
            return item;
          }
          replaced = true;
          return message;
        })
        .toList(growable: false);

    if (!replaced) {
      return false;
    }

    putScope(
      identity,
      existingScope.copyWith(optimisticMessages: optimisticMessages),
    );
    return true;
  }

  bool discardLocalMessage(
    ConversationIdentity identity,
    String clientGeneratedId,
  ) {
    final existingScope = scopeFor(identity);
    if (existingScope == null || clientGeneratedId.isEmpty) {
      return false;
    }

    var removed = false;
    final optimisticMessages = existingScope.optimisticMessages
        .where((item) {
          final keep = item.clientGeneratedId != clientGeneratedId;
          if (!keep) {
            removed = true;
          }
          return keep;
        })
        .toList(growable: false);

    if (!removed) {
      return false;
    }

    putScope(
      identity,
      existingScope.copyWith(optimisticMessages: optimisticMessages),
    );
    return true;
  }

  bool deleteMessage(ConversationIdentity identity, int serverMessageId) {
    final existingScope = scopeFor(identity);
    if (existingScope == null) {
      return false;
    }

    var removed = false;
    final segments = existingScope.segments
        .expand((segment) {
          final remainingMessages = segment.orderedMessages
              .where((message) {
                final keep = message.serverMessageId != serverMessageId;
                if (!keep) {
                  removed = true;
                }
                return keep;
              })
              .toList(growable: false);
          if (remainingMessages.isEmpty) {
            return const <ConversationTimelineCanonicalSegment>[];
          }
          return <ConversationTimelineCanonicalSegment>[
            ConversationTimelineCanonicalSegment(
              orderedMessages: remainingMessages,
            ),
          ];
        })
        .toList(growable: false);

    if (!removed) {
      return false;
    }

    putScope(identity, existingScope.copyWith(segments: segments));
    return true;
  }

  List<ConversationMessageV2> _mergeLatestMessages(
    List<ConversationMessageV2> existingMessages,
    ConversationMessageV2 incoming,
  ) {
    final incomingServerMessageId = incoming.serverMessageId;
    assert(
      incomingServerMessageId != null,
      '_mergeLatestMessages requires a server-backed message',
    );
    if (incomingServerMessageId == null) {
      return existingMessages;
    }

    final updated = existingMessages.toList(growable: true);

    for (var index = updated.length - 1; index >= 0; index--) {
      final current = updated[index];
      final currentServerMessageId = current.serverMessageId;
      assert(
        currentServerMessageId != null,
        '_mergeLatestMessages only operates on server-backed latest messages',
      );
      if (currentServerMessageId == null) {
        continue;
      }

      if (currentServerMessageId == incomingServerMessageId) {
        updated[index] = incoming;
        return updated.toList(growable: false);
      }

      if (currentServerMessageId < incomingServerMessageId) {
        updated.insert(index + 1, incoming);
        return updated.toList(growable: false);
      }
    }

    updated.insert(0, incoming);
    return updated.toList(growable: false);
  }

  List<ConversationMessageV2> _withoutConfirmedOptimisticMessages(
    List<ConversationMessageV2> optimisticMessages,
    ConversationTimelineCanonicalSegment confirmedSegment,
  ) {
    if (optimisticMessages.isEmpty) {
      return optimisticMessages;
    }
    final confirmedClientIds = confirmedSegment.orderedMessages
        .map((message) => message.clientGeneratedId)
        .where((clientGeneratedId) => clientGeneratedId.isNotEmpty)
        .toSet();
    if (confirmedClientIds.isEmpty) {
      return optimisticMessages;
    }
    return optimisticMessages
        .where(
          (message) => !confirmedClientIds.contains(message.clientGeneratedId),
        )
        .toList(growable: false);
  }

  ConversationTimelineCanonicalSegment _preserveLocalSendOrder(
    ConversationTimelineCanonicalSegment segment,
    List<ConversationMessageV2> optimisticMessages,
  ) {
    if (optimisticMessages.isEmpty) {
      return segment;
    }
    final optimisticByClientId = <String, ConversationMessageV2>{
      for (final message in optimisticMessages)
        if (message.clientGeneratedId.isNotEmpty)
          message.clientGeneratedId: message,
    };
    if (optimisticByClientId.isEmpty) {
      return segment;
    }

    var changed = false;
    final orderedMessages = segment.orderedMessages
        .map((message) {
          final optimistic = optimisticByClientId[message.clientGeneratedId];
          if (optimistic?.localSendOrder == null) {
            return message;
          }
          changed = true;
          return message.copyWith(localSendOrder: optimistic!.localSendOrder);
        })
        .toList(growable: false);

    if (!changed) {
      return segment;
    }
    return ConversationTimelineCanonicalSegment(
      orderedMessages: orderedMessages,
    );
  }

  List<ConversationTimelineCanonicalSegment> _normalizeBeforeAnchorSegments(
    List<ConversationTimelineCanonicalSegment> existingSegments, {
    required ConversationTimelineCanonicalSegment incoming,
    required int anchorServerMessageId,
  }) {
    final incomingStartId = incoming.firstServerMessageId;

    final result = <ConversationTimelineCanonicalSegment>[];
    var emittedIncoming = false;

    for (final existing in existingSegments) {
      if (emittedIncoming) {
        result.add(existing);
        continue;
      }

      if (existing.endsBeforeServerMessageId(incomingStartId)) {
        result.add(existing);
        continue;
      }

      if (existing.endsBeforeServerMessageId(anchorServerMessageId)) {
        final prefix = existing.messagesBefore(incomingStartId);
        if (prefix != null) {
          result.add(prefix);
        }
        continue;
      }

      final prefix = existing.messagesBefore(incomingStartId);
      if (prefix != null) {
        result.add(prefix);
      }
      final suffix = existing.messagesFrom(anchorServerMessageId);
      result.add(_concatenateSegments(incoming, suffix));
      emittedIncoming = true;
    }

    if (!emittedIncoming) {
      result.add(incoming);
    }

    return result;
  }

  List<ConversationTimelineCanonicalSegment> _normalizeAfterAnchorSegments(
    List<ConversationTimelineCanonicalSegment> existingSegments, {
    required ConversationTimelineCanonicalSegment incoming,
    required int anchorServerMessageId,
  }) {
    final incomingEndId = incoming.lastServerMessageId;

    final result = <ConversationTimelineCanonicalSegment>[];
    var emittedIncoming = false;
    var pendingIncoming = incoming;

    for (final existing in existingSegments) {
      if (emittedIncoming) {
        result.add(existing);
        continue;
      }

      if (existing.endsBeforeServerMessageId(anchorServerMessageId)) {
        result.add(existing);
        continue;
      }

      if (existing.startsAfterServerMessageId(incomingEndId)) {
        if (!emittedIncoming) {
          result.add(pendingIncoming);
          emittedIncoming = true;
        }
        result.add(existing);
        continue;
      }

      final prefix = existing.messagesThrough(anchorServerMessageId);
      if (prefix != null) {
        pendingIncoming = _concatenateSegments(prefix, incoming);
      }
      final suffix = existing.messagesAfter(incomingEndId);
      if (suffix != null) {
        result.add(pendingIncoming);
        emittedIncoming = true;
        result.add(suffix);
      }
    }

    if (!emittedIncoming) {
      result.add(pendingIncoming);
    }

    return result;
  }

  List<ConversationTimelineCanonicalSegment> _normalizeAroundSegments(
    List<ConversationTimelineCanonicalSegment> existingSegments, {
    required ConversationTimelineCanonicalSegment incoming,
  }) {
    final incomingStartId = incoming.firstServerMessageId;
    final incomingEndId = incoming.lastServerMessageId;

    final result = <ConversationTimelineCanonicalSegment>[];
    var emittedIncoming = false;

    for (final existing in existingSegments) {
      if (existing.endsBeforeServerMessageId(incomingStartId)) {
        result.add(existing);
        continue;
      }

      if (existing.startsAfterServerMessageId(incomingEndId)) {
        if (!emittedIncoming) {
          result.add(incoming);
          emittedIncoming = true;
        }
        result.add(existing);
        continue;
      }

      final prefix = existing.messagesBefore(incomingStartId);
      if (prefix != null) {
        result.add(prefix);
      }
      if (!emittedIncoming) {
        result.add(incoming);
        emittedIncoming = true;
      }
      final suffix = existing.messagesAfter(incomingEndId);
      if (suffix != null) {
        result.add(suffix);
      }
    }

    if (!emittedIncoming) {
      result.add(incoming);
    }

    return result;
  }

  List<ConversationTimelineCanonicalSegment> _normalizeLatestSegments(
    List<ConversationTimelineCanonicalSegment> existingSegments, {
    required ConversationTimelineCanonicalSegment incoming,
  }) {
    final incomingStartId = incoming.firstServerMessageId;

    final result = <ConversationTimelineCanonicalSegment>[];
    var insertedIncoming = false;

    for (final existing in existingSegments) {
      if (insertedIncoming) {
        continue;
      }

      if (existing.endsBeforeServerMessageId(incomingStartId)) {
        result.add(existing);
        continue;
      }

      final prefix = existing.messagesBefore(incomingStartId);
      if (prefix != null) {
        result.add(prefix);
      }
      result.add(incoming);
      insertedIncoming = true;
    }

    if (!insertedIncoming) {
      result.add(incoming);
    }

    return result;
  }

  ConversationTimelineCanonicalSegment _concatenateSegments(
    ConversationTimelineCanonicalSegment left,
    ConversationTimelineCanonicalSegment? right,
  ) {
    if (right == null) {
      return left;
    }

    return ConversationTimelineCanonicalSegment(
      orderedMessages: [...left.orderedMessages, ...right.orderedMessages],
    );
  }
}

final conversationTimelineMessageStoreProvider =
    NotifierProvider<
      ConversationTimelineMessageStore,
      ConversationTimelineMessageStoreState
    >(ConversationTimelineMessageStore.new);

typedef ConversationTimelineActiveSegmentProviderArgs = ({
  ConversationIdentity identity,
  ConversationTimelineActiveSegmentMode mode,
});

final conversationTimelineActiveSegmentProvider =
    Provider.family<
      ConversationTimelineActiveSegment?,
      ConversationTimelineActiveSegmentProviderArgs
    >((ref, args) {
      final scope = ref.watch(
        conversationTimelineMessageStoreProvider.select(
          (state) => state[args.identity],
        ),
      );
      if (scope == null) {
        return null;
      }

      if (args.mode.isLatest) {
        if (!scope.hasReachedLatest) {
          return null;
        }

        if (scope.segments.isEmpty) {
          if (scope.optimisticMessages.isEmpty) {
            return (
              orderedMessages: const <ConversationMessageV2>[],
              canLoadBefore: false,
              canLoadAfter: false,
              isLatestSlice: true,
            );
          }
          return (
            orderedMessages: scope.optimisticMessages,
            canLoadBefore: !scope.hasReachedOldest,
            canLoadAfter: false,
            isLatestSlice: true,
          );
        }

        final latestSegment = scope.segments.last;
        return _activeSegmentForScopeSegment(
          scope,
          latestSegment,
          selectedIndex: scope.segments.length - 1,
        );
      }

      final targetServerMessageId = args.mode.targetServerMessageId;
      if (targetServerMessageId == null) {
        return null;
      }

      for (var index = 0; index < scope.segments.length; index++) {
        final segment = scope.segments[index];
        if (segment.firstServerMessageId <= targetServerMessageId &&
            segment.lastServerMessageId >= targetServerMessageId) {
          return _activeSegmentForScopeSegment(
            scope,
            segment,
            selectedIndex: index,
          );
        }
      }

      return null;
    });

ConversationTimelineActiveSegment _activeSegmentForScopeSegment(
  ConversationTimelineCanonicalScope scope,
  ConversationTimelineCanonicalSegment selectedSegment, {
  required int selectedIndex,
}) {
  final isLatestSegment =
      scope.hasReachedLatest && selectedIndex == scope.segments.length - 1;
  final isFirstSegment = selectedIndex == 0;
  final orderedMessages = isLatestSegment
      ? _mergeLatestSliceMessages(
          selectedSegment.orderedMessages,
          scope.optimisticMessages,
        )
      : selectedSegment.orderedMessages;

  return (
    orderedMessages: orderedMessages,
    canLoadBefore: !isFirstSegment || !scope.hasReachedOldest,
    canLoadAfter: !isLatestSegment,
    isLatestSlice: isLatestSegment,
  );
}

List<ConversationMessageV2> _mergeLatestSliceMessages(
  List<ConversationMessageV2> canonicalMessages,
  List<ConversationMessageV2> optimisticMessages,
) {
  if (optimisticMessages.isEmpty) {
    return canonicalMessages;
  }

  final canonicalClientIds = canonicalMessages
      .map((message) => message.clientGeneratedId)
      .where((clientGeneratedId) => clientGeneratedId.isNotEmpty)
      .toSet();
  final mergedOptimisticMessages = optimisticMessages
      .where(
        (message) => !canonicalClientIds.contains(message.clientGeneratedId),
      )
      .toList(growable: false);
  if (mergedOptimisticMessages.isEmpty) {
    return canonicalMessages;
  }

  mergedOptimisticMessages.sort((left, right) {
    final leftOrder = left.localSendOrder;
    final rightOrder = right.localSendOrder;
    if (leftOrder == null && rightOrder == null) {
      return 0;
    }
    if (leftOrder == null) {
      return 1;
    }
    if (rightOrder == null) {
      return -1;
    }
    return leftOrder.compareTo(rightOrder);
  });

  final result = <ConversationMessageV2>[];
  var optimisticIndex = 0;
  for (final canonicalMessage in canonicalMessages) {
    final canonicalOrder = canonicalMessage.localSendOrder;
    if (canonicalOrder != null) {
      while (optimisticIndex < mergedOptimisticMessages.length) {
        final optimisticMessage = mergedOptimisticMessages[optimisticIndex];
        final optimisticOrder = optimisticMessage.localSendOrder;
        if (optimisticOrder == null || optimisticOrder >= canonicalOrder) {
          break;
        }
        result.add(optimisticMessage);
        optimisticIndex++;
      }
    }
    result.add(canonicalMessage);
  }

  result.addAll(mergedOptimisticMessages.skip(optimisticIndex));
  return result;
}
