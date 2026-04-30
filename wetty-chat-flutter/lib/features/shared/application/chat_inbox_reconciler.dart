import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/core/notifications/unread_badge_provider.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/chat_list/application/group_list_v2_view_model.dart';
import 'package:chahua/features/chat_list/application/thread_list_v2_view_model.dart';

class ChatInboxReconciler {
  ChatInboxReconciler(this._ref);

  final Ref _ref;

  Future<void> reconcile({bool userInitiated = false}) async {
    if (!_ref.read(authSessionProvider).isAuthenticated) {
      return;
    }

    await Future.wait([
      _refreshGroups(),
      _refreshThreads(),
      _ref.read(unreadBadgeProvider.notifier).refresh(),
    ]);
  }

  Future<void> reconcileGroups() async {
    if (!_ref.read(authSessionProvider).isAuthenticated) {
      return;
    }

    await Future.wait([
      _refreshGroups(),
      _ref.read(unreadBadgeProvider.notifier).refreshChatUnreadTotal(),
    ]);
  }

  Future<void> reconcileThreads() async {
    if (!_ref.read(authSessionProvider).isAuthenticated) {
      return;
    }

    await _refreshThreads();
  }

  Future<void> _refreshGroups() async {
    final current = _ref.read(groupListV2ViewModelProvider).value;
    if (current == null) {
      await _ref.read(groupListV2ViewModelProvider.future);
      return;
    }
    await _ref.read(groupListV2ViewModelProvider.notifier).refreshGroups();
  }

  Future<void> _refreshThreads() async {
    final current = _ref.read(activeThreadListV2ViewModelProvider).value;
    if (current == null) {
      await _ref.read(activeThreadListV2ViewModelProvider.future);
      return;
    }
    await _ref
        .read(activeThreadListV2ViewModelProvider.notifier)
        .refreshThreads();
  }
}

final chatInboxReconcilerProvider = Provider<ChatInboxReconciler>((ref) {
  return ChatInboxReconciler(ref);
});
