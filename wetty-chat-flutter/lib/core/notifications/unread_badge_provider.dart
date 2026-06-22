import 'dart:async';
import 'dart:developer' as developer;
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models/chats_api_models.dart';
import '../session/dev_session_store.dart';
import '../api/models/thread_api_models.dart';
import '../api/services/chat_api_service.dart';
import '../api/services/thread_api_service.dart';
import 'apns_channel.dart';

class UnreadBadgeState {
  const UnreadBadgeState({
    this.chatUnreadMessageCount = 0,
    this.archivedChatUnreadMessageCount = 0,
    this.threadUnreadMessageCount = 0,
    this.archivedThreadUnreadMessageCount = 0,
    this.chatUnreadItemCount = 0,
    this.archivedChatUnreadItemCount = 0,
    this.threadUnreadItemCount = 0,
    this.archivedThreadUnreadItemCount = 0,
    this.isRefreshing = false,
  });

  final int chatUnreadMessageCount;
  final int archivedChatUnreadMessageCount;
  final int threadUnreadMessageCount;
  final int archivedThreadUnreadMessageCount;
  final int chatUnreadItemCount;
  final int archivedChatUnreadItemCount;
  final int threadUnreadItemCount;
  final int archivedThreadUnreadItemCount;
  final bool isRefreshing;

  int get activeUnreadMessageCount =>
      chatUnreadMessageCount + threadUnreadMessageCount;

  int get archivedUnreadMessageCount =>
      archivedChatUnreadMessageCount + archivedThreadUnreadMessageCount;

  int get activeUnreadItemCount => chatUnreadItemCount + threadUnreadItemCount;

  int get archivedUnreadItemCount =>
      archivedChatUnreadItemCount + archivedThreadUnreadItemCount;

  UnreadBadgeState copyWith({
    int? chatUnreadMessageCount,
    int? archivedChatUnreadMessageCount,
    int? threadUnreadMessageCount,
    int? archivedThreadUnreadMessageCount,
    int? chatUnreadItemCount,
    int? archivedChatUnreadItemCount,
    int? threadUnreadItemCount,
    int? archivedThreadUnreadItemCount,
    bool? isRefreshing,
  }) {
    return UnreadBadgeState(
      chatUnreadMessageCount:
          chatUnreadMessageCount ?? this.chatUnreadMessageCount,
      archivedChatUnreadMessageCount:
          archivedChatUnreadMessageCount ?? this.archivedChatUnreadMessageCount,
      threadUnreadMessageCount:
          threadUnreadMessageCount ?? this.threadUnreadMessageCount,
      archivedThreadUnreadMessageCount:
          archivedThreadUnreadMessageCount ??
          this.archivedThreadUnreadMessageCount,
      chatUnreadItemCount: chatUnreadItemCount ?? this.chatUnreadItemCount,
      archivedChatUnreadItemCount:
          archivedChatUnreadItemCount ?? this.archivedChatUnreadItemCount,
      threadUnreadItemCount:
          threadUnreadItemCount ?? this.threadUnreadItemCount,
      archivedThreadUnreadItemCount:
          archivedThreadUnreadItemCount ?? this.archivedThreadUnreadItemCount,
      isRefreshing: isRefreshing ?? this.isRefreshing,
    );
  }
}

int chatBadgeContribution({
  required int unreadCount,
  required DateTime? mutedUntil,
  DateTime? now,
}) {
  if (unreadCount <= 0) {
    return 0;
  }
  final effectiveNow = now ?? DateTime.now();
  if (mutedUntil != null && mutedUntil.isAfter(effectiveNow)) {
    return 0;
  }
  return unreadCount;
}

class UnreadBadgeNotifier extends Notifier<UnreadBadgeState> {
  Timer? _reconcileTimer;
  bool _isDisposed = false;
  bool _isWritingNativeBadge = false;

  ChatApiService get _chatApi => ref.read(chatApiServiceProvider);
  ThreadApiService get _threadApi => ref.read(threadApiServiceProvider);
  ApnsChannel get _apns => ref.read(apnsChannelProvider);

  @override
  UnreadBadgeState build() {
    _isDisposed = false;

    ref.listen<AuthSessionState>(authSessionProvider, (previous, next) {
      if (!next.isAuthenticated) {
        _reconcileTimer?.cancel();
        _replaceState(const UnreadBadgeState());
        unawaited(_syncNativeBadge(0));
        return;
      }
      if (previous?.isAuthenticated != true) {
        unawaited(refresh());
      }
    });

    ref.onDispose(() {
      _isDisposed = true;
      _reconcileTimer?.cancel();
    });

    if (ref.read(authSessionProvider).isAuthenticated) {
      Future.microtask(refresh);
    }

    return const UnreadBadgeState();
  }

  Future<void> refresh() async {
    if (!ref.read(authSessionProvider).isAuthenticated) {
      return;
    }
    _reconcileTimer?.cancel();
    _replaceState(state.copyWith(isRefreshing: true));
    try {
      final results = await Future.wait([
        _chatApi.fetchUnreadCount(),
        _threadApi.fetchUnreadThreadCount(),
      ]);
      final chatResult = results[0] as UnreadCountResponseDto;
      final threadResult = results[1] as UnreadThreadCountResponseDto;
      if (_isDisposed) {
        return;
      }
      final nextState = state.copyWith(
        chatUnreadMessageCount: _clampUnread(chatResult.unreadCount),
        archivedChatUnreadMessageCount: _clampUnread(
          chatResult.archivedUnreadCount,
        ),
        threadUnreadMessageCount: _clampUnread(threadResult.unreadMessageCount),
        archivedThreadUnreadMessageCount: _clampUnread(
          threadResult.archivedUnreadMessageCount,
        ),
        chatUnreadItemCount: _clampUnread(chatResult.unreadChatCount),
        archivedChatUnreadItemCount: _clampUnread(
          chatResult.archivedUnreadChatCount,
        ),
        threadUnreadItemCount: _clampUnread(threadResult.unreadThreadCount),
        archivedThreadUnreadItemCount: _clampUnread(
          threadResult.archivedUnreadThreadCount,
        ),
        isRefreshing: false,
      );
      _replaceState(nextState);
      await _syncNativeBadge(nextState.activeUnreadMessageCount);
    } catch (error, stackTrace) {
      developer.log(
        'Failed to refresh unread badge totals: $error',
        name: 'UnreadBadge',
        stackTrace: stackTrace,
      );
      if (!_isDisposed) {
        _replaceState(state.copyWith(isRefreshing: false));
      }
    }
  }

  Future<void> refreshChatUnreadSummary() async {
    if (!ref.read(authSessionProvider).isAuthenticated) {
      return;
    }
    try {
      final result = await _chatApi.fetchUnreadCount();
      if (_isDisposed) {
        return;
      }
      _replaceState(
        state.copyWith(
          chatUnreadMessageCount: _clampUnread(result.unreadCount),
          archivedChatUnreadMessageCount: _clampUnread(
            result.archivedUnreadCount,
          ),
          chatUnreadItemCount: _clampUnread(result.unreadChatCount),
          archivedChatUnreadItemCount: _clampUnread(
            result.archivedUnreadChatCount,
          ),
        ),
      );
    } catch (error, stackTrace) {
      developer.log(
        'Failed to refresh chat unread summary: $error',
        name: 'UnreadBadge',
        stackTrace: stackTrace,
      );
    }
  }

  Future<void> refreshThreadUnreadSummary() async {
    if (!ref.read(authSessionProvider).isAuthenticated) {
      return;
    }
    try {
      final result = await _threadApi.fetchUnreadThreadCount();
      if (_isDisposed) {
        return;
      }
      replaceThreadUnreadSummary(result);
    } catch (error, stackTrace) {
      developer.log(
        'Failed to refresh thread unread summary: $error',
        name: 'UnreadBadge',
        stackTrace: stackTrace,
      );
    }
  }

  void scheduleReconcile({Duration delay = const Duration(milliseconds: 800)}) {
    if (!ref.read(authSessionProvider).isAuthenticated) {
      return;
    }
    _reconcileTimer?.cancel();
    _reconcileTimer = Timer(delay, () => unawaited(refresh()));
  }

  void applyChatUnreadMessageDelta(int delta) {
    if (delta == 0) {
      return;
    }
    _replaceState(
      state.copyWith(
        chatUnreadMessageCount: _clampUnread(
          state.chatUnreadMessageCount + delta,
        ),
      ),
    );
  }

  void applyThreadUnreadMessageDelta(int delta) {
    if (delta == 0) {
      return;
    }
    _replaceState(
      state.copyWith(
        threadUnreadMessageCount: _clampUnread(
          state.threadUnreadMessageCount + delta,
        ),
      ),
    );
  }

  void replaceThreadUnreadSummary(UnreadThreadCountResponseDto summary) {
    _replaceState(
      state.copyWith(
        threadUnreadMessageCount: _clampUnread(summary.unreadMessageCount),
        archivedThreadUnreadMessageCount: _clampUnread(
          summary.archivedUnreadMessageCount,
        ),
        threadUnreadItemCount: _clampUnread(summary.unreadThreadCount),
        archivedThreadUnreadItemCount: _clampUnread(
          summary.archivedUnreadThreadCount,
        ),
      ),
    );
  }

  void _replaceState(UnreadBadgeState next) {
    if (_isDisposed) {
      return;
    }
    final previousCount = state.activeUnreadMessageCount;
    state = next;
    final nextCount = next.activeUnreadMessageCount;
    if (previousCount != nextCount) {
      unawaited(_syncNativeBadge(nextCount));
    }
  }

  Future<void> _syncNativeBadge(int count) async {
    if (!ref.read(authSessionProvider).isAuthenticated ||
        !_supportsNativeBadge ||
        _isWritingNativeBadge) {
      return;
    }

    _isWritingNativeBadge = true;
    try {
      if (count <= 0) {
        await _apns.clearBadge();
      } else {
        await _apns.setBadge(count);
      }
    } catch (error, stackTrace) {
      developer.log(
        'Failed to sync native badge: $error',
        name: 'UnreadBadge',
        stackTrace: stackTrace,
      );
    } finally {
      _isWritingNativeBadge = false;
    }
  }

  bool get _supportsNativeBadge => !kIsWeb && Platform.isIOS;

  int _clampUnread(int value) => value < 0 ? 0 : value;
}

final unreadBadgeProvider =
    NotifierProvider<UnreadBadgeNotifier, UnreadBadgeState>(
      UnreadBadgeNotifier.new,
    );
