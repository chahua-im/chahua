import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'dart:async';

import '../../features/conversation/shared/data/conversation_realtime_message_applier.dart';
import '../../features/conversation/shared/application/thread_detail_membership_view_model.dart';
import '../../features/chat_list/application/group_list_v2_store.dart';
import '../../features/chat_list/application/thread_list_v2_store.dart';
import '../../features/conversation/pins/application/pinned_messages_provider.dart';
import '../../features/groups/metadata/application/group_metadata_view_model.dart';
import '../../features/shared/application/chat_inbox_reconciler.dart';
import '../../features/stickers/data/sticker_pack_order_store.dart';
import '../api/models/websocket_api_models.dart';
import '../notifications/unread_badge_provider.dart';
import 'websocket_service.dart';

/// Centralizes websocket event fan-out to app subsystems.
final wsEventRouterProvider = Provider<void>((ref) {
  StreamSubscription<ApiWsEvent>? subscription;
  bool isReconcilingGroups = false;
  bool isReconcilingThreads = false;

  void reconcileGroupsIfNeeded(bool shouldReconcile) {
    if (!shouldReconcile || isReconcilingGroups) {
      return;
    }

    isReconcilingGroups = true;
    unawaited(
      ref
          .read(chatInboxReconcilerProvider)
          .reconcileGroups()
          .whenComplete(() => isReconcilingGroups = false),
    );
  }

  void reconcileThreadsIfNeeded(bool shouldReconcile) {
    if (!shouldReconcile || isReconcilingThreads) {
      return;
    }

    isReconcilingThreads = true;
    unawaited(
      ref
          .read(chatInboxReconcilerProvider)
          .reconcileThreads()
          .whenComplete(() => isReconcilingThreads = false),
    );
  }

  void invalidateThreadDetailMembership({
    required int chatId,
    required int threadRootId,
  }) {
    ref.invalidate(
      threadDetailMembershipViewModelProvider((
        chatId: chatId,
        threadRootId: threadRootId,
      )),
    );
  }

  void applyMessageProjectionEvent(ApiWsEvent event, int? replyRootId) {
    final shouldReconcile = replyRootId == null
        ? ref.read(groupListV2StoreProvider.notifier).applyRealtimeEvent(event)
        : ref
              .read(threadListV2StoreProvider.notifier)
              .applyRealtimeEvent(event);
    ref.read(unreadBadgeProvider.notifier).scheduleReconcile();
    if (replyRootId == null) {
      reconcileGroupsIfNeeded(shouldReconcile);
    } else {
      reconcileThreadsIfNeeded(shouldReconcile);
    }
  }

  void applyListProjectionEvent(ApiWsEvent event) {
    // TODO: Handle backend read-state websocket events here once the API
    // exposes them, so external read/unread changes update v2 stores live.
    switch (event) {
      case MessageCreatedWsEvent(:final payload):
      case MessageUpdatedWsEvent(:final payload):
      case MessageDeletedWsEvent(:final payload):
        applyMessageProjectionEvent(event, payload.replyRootId);
        return;
      case ThreadUpdatedWsEvent(:final payload):
        invalidateThreadDetailMembership(
          chatId: payload.chatId,
          threadRootId: payload.threadRootId,
        );
        final shouldReconcile = ref
            .read(threadListV2StoreProvider.notifier)
            .applyRealtimeEvent(event);
        reconcileThreadsIfNeeded(shouldReconcile);
        return;
      case ThreadMembershipChangedWsEvent(:final payload):
        invalidateThreadDetailMembership(
          chatId: payload.chatId,
          threadRootId: payload.threadRootId,
        );
        reconcileThreadsIfNeeded(true);
        return;
      case ChatArchiveStateChangedWsEvent(:final payload):
        ref.invalidate(
          groupMetadataViewModelProvider(payload.chatId.toString()),
        );
        reconcileGroupsIfNeeded(true);
        return;
      case ReactionUpdatedWsEvent():
      case PinAddedWsEvent():
      case PinRemovedWsEvent():
        return;
      case StickerPackOrderUpdatedWsEvent():
        return;
      case PongWsEvent():
        return;
    }
  }

  void applyAuxiliaryEvent(ApiWsEvent event) {
    switch (event) {
      case StickerPackOrderUpdatedWsEvent(:final payload):
        final order = payload.order
            .map(
              (dto) => StickerPackOrderItem(
                stickerPackId: dto.stickerPackId,
                lastUsedOn: dto.lastUsedOn,
              ),
            )
            .toList(growable: false);
        ref.read(stickerPackOrderProvider.notifier).replaceOrderFromWs(order);
        return;
      case PinAddedWsEvent(:final payload):
        ref
            .read(
              pinnedMessagesProvider((
                chatId: payload.chatId,
                threadRootId: null,
              )).notifier,
            )
            .applyPinAdded(payload);
        return;
      case PinRemovedWsEvent(:final payload):
        ref
            .read(
              pinnedMessagesProvider((
                chatId: payload.chatId,
                threadRootId: null,
              )).notifier,
            )
            .applyPinRemoved(payload);
        return;
      case MessageCreatedWsEvent():
      case MessageUpdatedWsEvent():
      case MessageDeletedWsEvent():
      case ReactionUpdatedWsEvent():
      case ThreadUpdatedWsEvent():
      case ThreadMembershipChangedWsEvent():
      case ChatArchiveStateChangedWsEvent():
      case PongWsEvent():
        return;
    }
  }

  /// This is the main "entry point" for websocket events.
  void bind(WebSocketService service) {
    subscription?.cancel();
    subscription = service.events.listen((event) {
      // Registration ROOT

      // Apply the event to the conversation timeline v2 realtime applier.
      ref.read(conversationTimelineV2RealtimeApplierProvider).apply(event);

      // Handle how message event could affect the chat list
      applyListProjectionEvent(event);
      applyAuxiliaryEvent(event);
    });
  }

  ref.listen<WebSocketService>(webSocketProvider, (previous, next) {
    if (!identical(previous, next)) {
      bind(next);
    }
  }, fireImmediately: true);
  ref.onDispose(() async => subscription?.cancel());
});
