import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/models/messages_api_models.dart';
import '../../../core/api/models/websocket_api_models.dart';
import '../../../core/notifications/unread_badge_provider.dart';
import '../../../core/session/dev_session_store.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import '../model/thread_list_item.dart';
import '../../shared/data/read_state_models.dart';
import 'realtime_projection_policy.dart';

typedef ThreadListV2ListState = ({
  List<ThreadListItem> threads,
  String? nextCursor,
  bool hasMore,
  bool isLoaded,
});

typedef ThreadUnreadTotals = ({
  int activeThreadCount,
  int archivedThreadCount,
  int activeMessageCount,
  int archivedMessageCount,
});

typedef ThreadListV2StoreState = ({
  ThreadListV2ListState active,
  ThreadListV2ListState archived,
  bool hasArchivedThreads,
  ThreadUnreadTotals unreadTotals,
});

typedef ThreadListV2Identity = ({String chatId, String threadRootId});

typedef _ThreadLocation = ({bool archived, int index});

class ThreadListV2Store extends Notifier<ThreadListV2StoreState> {
  @override
  ThreadListV2StoreState build() {
    return (
      active: _emptyListState(),
      archived: _emptyListState(),
      hasArchivedThreads: false,
      unreadTotals: _emptyUnreadTotals(),
    );
  }

  void replaceActivePage({
    required List<ThreadListItem> threads,
    String? nextCursor,
  }) {
    _replaceState(active: _listStateWithPage(threads, nextCursor));
  }

  void replaceArchivedPage({
    required List<ThreadListItem> threads,
    String? nextCursor,
  }) {
    _replaceState(
      archived: _listStateWithPage(threads, nextCursor),
      hasArchivedThreads: threads.isNotEmpty,
    );
  }

  void replaceHasArchivedThreads(bool hasArchivedThreads) {
    _replaceState(hasArchivedThreads: hasArchivedThreads);
  }

  void appendActivePage({
    required List<ThreadListItem> threads,
    String? nextCursor,
  }) {
    _replaceState(
      active: _listStateWithAppendedPage(state.active, threads, nextCursor),
    );
  }

  void appendArchivedPage({
    required List<ThreadListItem> threads,
    String? nextCursor,
  }) {
    _replaceState(
      archived: _listStateWithAppendedPage(state.archived, threads, nextCursor),
      hasArchivedThreads: state.hasArchivedThreads || threads.isNotEmpty,
    );
  }

  void replaceUnreadTotals(ThreadUnreadTotals unreadTotals) {
    _replaceState(unreadTotals: unreadTotals);
  }

  void applyServerReadState({
    required int threadRootId,
    required ThreadReadStateUpdate response,
  }) {
    final location = _locationOfThread(threadRootId);
    if (location == null) {
      return;
    }

    final listState = location.archived ? state.archived : state.active;
    final previous = listState.threads[location.index];
    final updated = previous.copyWith(unreadCount: response.unreadCount);
    _replaceListThreads(
      archived: location.archived,
      threads: _replaceThreadAt(listState.threads, location.index, updated),
    );
    _applyThreadUnreadDelta(
      archived: location.archived,
      previous: previous,
      updated: updated,
    );
  }

  bool applyRealtimeEvent(ApiWsEvent event) {
    switch (event) {
      case MessageCreatedWsEvent(:final payload):
        return _applyRealtimeCreated(payload);
      case MessageUpdatedWsEvent(:final payload):
        return _applyRealtimeUpdated(payload);
      case MessageDeletedWsEvent(:final payload):
        return _applyRealtimeDeleted(payload);
      case ThreadUpdatedWsEvent():
        return true;
      default:
        return false;
    }
  }

  bool _applyRealtimeCreated(MessageItemDto payload) {
    final threadRootId = payload.replyRootId;
    if (threadRootId == null || !isEligibleThreadPreviewPayload(payload)) {
      return false;
    }

    final location = _locationOfThreadInChat(payload.chatId, threadRootId);
    if (location == null) {
      return true;
    }

    final listState = location.archived ? state.archived : state.active;
    final previous = listState.threads[location.index];
    final alreadyProjected = matchesThreadPreview(previous.lastReply, payload);
    final isCurrentUserMessage = payload.sender.uid == _currentUserId;
    final updated = previous.copyWith(
      lastReply: _toReplyPreview(payload),
      lastReplyAt: payload.createdAt ?? previous.lastReplyAt,
      replyCount: alreadyProjected
          ? previous.replyCount
          : previous.replyCount + 1,
      unreadCount: isCurrentUserMessage
          ? 0
          : alreadyProjected
          ? previous.unreadCount
          : previous.unreadCount + 1,
    );
    _replaceListThreads(
      archived: location.archived,
      threads: _reinsertThreadByActivity(
        listState.threads,
        location.index,
        updated,
      ),
    );
    _applyThreadUnreadDelta(
      archived: location.archived,
      previous: previous,
      updated: updated,
    );
    return false;
  }

  bool _applyRealtimeUpdated(MessageItemDto payload) {
    if (payload.replyRootId == null) {
      return _applyRootPatched(payload);
    }

    final location = _locationOfThreadInChat(
      payload.chatId,
      payload.replyRootId!,
    );
    if (location == null) {
      return true;
    }

    final listState = location.archived ? state.archived : state.active;
    final previous = listState.threads[location.index];
    if (!matchesThreadPreview(previous.lastReply, payload)) {
      return false;
    }

    _replaceListThreads(
      archived: location.archived,
      threads: _replaceThreadAt(
        listState.threads,
        location.index,
        previous.copyWith(lastReply: _toReplyPreview(payload)),
      ),
    );
    return false;
  }

  bool _applyRealtimeDeleted(MessageItemDto payload) {
    if (payload.replyRootId == null) {
      return _applyRootPatched(payload);
    }

    final location = _locationOfThreadInChat(
      payload.chatId,
      payload.replyRootId!,
    );
    if (location == null) {
      return true;
    }

    final listState = location.archived ? state.archived : state.active;
    final previous = listState.threads[location.index];
    final isCurrentPreview = matchesThreadPreview(previous.lastReply, payload);
    if (isCurrentPreview) {
      return true;
    }

    final updated = previous.copyWith(
      replyCount: previous.replyCount > 0 ? previous.replyCount - 1 : 0,
    );
    _replaceListThreads(
      archived: location.archived,
      threads: _replaceThreadAt(listState.threads, location.index, updated),
    );
    return false;
  }

  int get _currentUserId => ref.read(authSessionProvider).currentUserId;

  _ThreadLocation? _locationOfThread(int threadRootId) {
    final activeIndex = state.active.threads.indexWhere(
      (thread) => thread.threadRootId == threadRootId,
    );
    if (activeIndex >= 0) {
      return (archived: false, index: activeIndex);
    }

    final archivedIndex = state.archived.threads.indexWhere(
      (thread) => thread.threadRootId == threadRootId,
    );
    if (archivedIndex >= 0) {
      return (archived: true, index: archivedIndex);
    }

    return null;
  }

  _ThreadLocation? _locationOfThreadInChat(int chatId, int threadRootId) {
    final chatIdString = chatId.toString();
    final activeIndex = state.active.threads.indexWhere(
      (thread) =>
          thread.chatId == chatIdString && thread.threadRootId == threadRootId,
    );
    if (activeIndex >= 0) {
      return (archived: false, index: activeIndex);
    }

    final archivedIndex = state.archived.threads.indexWhere(
      (thread) =>
          thread.chatId == chatIdString && thread.threadRootId == threadRootId,
    );
    if (archivedIndex >= 0) {
      return (archived: true, index: archivedIndex);
    }

    return null;
  }

  MessagePreview _toReplyPreview(MessageItemDto payload) {
    return messagePreviewFromMessageItemDto(payload);
  }

  bool _applyRootPatched(MessageItemDto payload) {
    final location = _locationOfThreadInChat(payload.chatId, payload.id);
    if (location == null) {
      return false;
    }

    final listState = location.archived ? state.archived : state.active;
    final previous = listState.threads[location.index];
    _replaceListThreads(
      archived: location.archived,
      threads: _replaceThreadAt(
        listState.threads,
        location.index,
        previous.copyWith(
          threadRootMessage: messagePreviewFromMessageItemDto(payload),
        ),
      ),
    );
    return false;
  }

  List<ThreadListItem> _replaceThreadAt(
    List<ThreadListItem> threads,
    int index,
    ThreadListItem updated,
  ) {
    final next = [...threads];
    next[index] = updated;
    return next;
  }

  List<ThreadListItem> _reinsertThreadByActivity(
    List<ThreadListItem> threads,
    int index,
    ThreadListItem updated,
  ) {
    final updatedActivity = updated.lastReplyAt;
    final next = [...threads]..removeAt(index);
    if (updatedActivity == null) {
      next.add(updated);
      return next;
    }

    final insertAt = next.indexWhere((candidate) {
      final candidateActivity = candidate.lastReplyAt;
      if (candidateActivity == null) {
        return true;
      }
      return updatedActivity.isAfter(candidateActivity);
    });
    if (insertAt < 0) {
      next.add(updated);
    } else {
      next.insert(insertAt, updated);
    }
    return next;
  }

  void _applyThreadUnreadDelta({
    required bool archived,
    required ThreadListItem previous,
    required ThreadListItem updated,
  }) {
    final delta = updated.unreadCount - previous.unreadCount;
    if (delta == 0) {
      return;
    }

    final totals = state.unreadTotals;
    if (archived) {
      _replaceState(
        unreadTotals: (
          activeThreadCount: totals.activeThreadCount,
          archivedThreadCount: _clampUnread(totals.archivedThreadCount + delta),
          activeMessageCount: totals.activeMessageCount,
          archivedMessageCount: totals.archivedMessageCount,
        ),
      );
      return;
    }

    _replaceState(
      unreadTotals: (
        activeThreadCount: _clampUnread(totals.activeThreadCount + delta),
        archivedThreadCount: totals.archivedThreadCount,
        activeMessageCount: totals.activeMessageCount,
        archivedMessageCount: totals.archivedMessageCount,
      ),
    );
    ref.read(unreadBadgeProvider.notifier).applyThreadUnreadDelta(delta);
  }

  void _replaceListThreads({
    required bool archived,
    required List<ThreadListItem> threads,
  }) {
    final listState = archived ? state.archived : state.active;
    final updatedList = (
      threads: threads,
      nextCursor: listState.nextCursor,
      hasMore: listState.hasMore,
      isLoaded: listState.isLoaded,
    );
    if (archived) {
      _replaceState(archived: updatedList);
    } else {
      _replaceState(active: updatedList);
    }
  }

  void _replaceState({
    ThreadListV2ListState? active,
    ThreadListV2ListState? archived,
    bool? hasArchivedThreads,
    ThreadUnreadTotals? unreadTotals,
  }) {
    state = (
      active: active ?? state.active,
      archived: archived ?? state.archived,
      hasArchivedThreads: hasArchivedThreads ?? state.hasArchivedThreads,
      unreadTotals: unreadTotals ?? state.unreadTotals,
    );
  }
}

ThreadListV2ListState _emptyListState() {
  return (
    threads: const <ThreadListItem>[],
    nextCursor: null,
    hasMore: false,
    isLoaded: false,
  );
}

ThreadUnreadTotals _emptyUnreadTotals() {
  return (
    activeThreadCount: 0,
    archivedThreadCount: 0,
    activeMessageCount: 0,
    archivedMessageCount: 0,
  );
}

ThreadListV2ListState _listStateWithPage(
  List<ThreadListItem> threads,
  String? nextCursor,
) {
  return (
    threads: threads,
    nextCursor: nextCursor,
    hasMore: nextCursor != null && nextCursor.isNotEmpty,
    isLoaded: true,
  );
}

ThreadListV2ListState _listStateWithAppendedPage(
  ThreadListV2ListState listState,
  List<ThreadListItem> threads,
  String? nextCursor,
) {
  final existingKeys = listState.threads
      .map((thread) => '${thread.chatId}:${thread.threadRootId}')
      .toSet();
  final appended = threads
      .where(
        (thread) =>
            !existingKeys.contains('${thread.chatId}:${thread.threadRootId}'),
      )
      .toList(growable: false);

  return (
    threads: [...listState.threads, ...appended],
    nextCursor: nextCursor,
    hasMore: nextCursor != null && nextCursor.isNotEmpty,
    isLoaded: true,
  );
}

int _clampUnread(int value) => value < 0 ? 0 : value;

final threadListV2StoreProvider =
    NotifierProvider<ThreadListV2Store, ThreadListV2StoreState>(
      ThreadListV2Store.new,
    );

final threadByIdProvider =
    Provider.family<ThreadListItem?, ThreadListV2Identity>((ref, identity) {
      return ref.watch(
        threadListV2StoreProvider.select((state) {
          ThreadListItem? findIn(List<ThreadListItem> threads) {
            return threads
                .where(
                  (thread) =>
                      thread.chatId == identity.chatId &&
                      thread.threadRootId.toString() == identity.threadRootId,
                )
                .firstOrNull;
          }

          return findIn(state.active.threads) ?? findIn(state.archived.threads);
        }),
      );
    });
