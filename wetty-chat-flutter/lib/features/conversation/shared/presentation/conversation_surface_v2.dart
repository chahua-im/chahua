import 'dart:async';
import 'dart:developer';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/shared/application/app_refresh_coordinator.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_composer_view_model.dart';
import 'package:chahua/features/conversation/pins/application/pinned_messages_provider.dart';
import 'package:chahua/features/conversation/pins/domain/pinned_message.dart';
import 'package:chahua/features/conversation/pins/presentation/pinned_message_banner.dart';
import 'package:chahua/features/conversation/pins/presentation/pinned_message_list_modal.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view_model.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view.dart';
import 'package:chahua/features/conversation/timeline/model/message_visibility_window.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/groups/metadata/application/group_metadata_view_model.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/domain/launch_request.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_compose_v2.dart';
import 'package:chahua/features/conversation/timeline/model/message_long_press_details_v2.dart';
import 'package:chahua/features/conversation/timeline/presentation/message_overlay_v2.dart';
import 'package:chahua/features/conversation/shared/presentation/conversation_presentation_scope.dart';
import 'package:chahua/l10n/app_localizations.dart';

class ConversationSurfaceV2 extends ConsumerStatefulWidget {
  const ConversationSurfaceV2({
    super.key,
    required this.identity,
    required this.launchRequest,
    this.onOpenThread,
    this.onStartThread,
    this.onMessageSent,
  });

  final ConversationIdentity identity;
  final LaunchRequest launchRequest;
  final void Function(ConversationMessageV2 message)? onOpenThread;
  final void Function(ConversationMessageV2 message)? onStartThread;
  final Future<void> Function()? onMessageSent;

  @override
  ConsumerState<ConversationSurfaceV2> createState() =>
      _ConversationSurfaceV2State();
}

class _ConversationSurfaceV2State extends ConsumerState<ConversationSurfaceV2> {
  static const List<String> _quickReactionEmojis = <String>[
    '👍',
    '❤️',
    '😂',
    '😮',
    '😢',
  ];

  final GlobalKey _surfaceKey = GlobalKey();
  final GlobalKey<ConversationComposeV2State> _composeKey =
      GlobalKey<ConversationComposeV2State>();
  late final AppRefreshCoordinator _refreshCoordinator;
  MessageLongPressDetailsV2? _activeOverlay;
  MessageVisibilityWindow? _visibleMessages;
  MessageVisibilityWindow? _pendingVisibilityWindow;
  bool _isVisibilityWindowUpdateScheduled = false;

  @override
  void initState() {
    super.initState();
    _refreshCoordinator = ref.read(appRefreshCoordinatorProvider);
    _registerRecovery();
  }

  @override
  void didUpdateWidget(ConversationSurfaceV2 oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.identity == widget.identity) {
      return;
    }
    _refreshCoordinator.unregisterConversationRecovery(oldWidget.identity);
    _visibleMessages = null;
    _registerRecovery();
  }

  @override
  void dispose() {
    _refreshCoordinator.unregisterConversationRecovery(widget.identity);
    super.dispose();
  }

  void _registerRecovery() {
    final identity = widget.identity;
    _refreshCoordinator.registerConversationRecovery(
      identity: identity,
      recover: (_) {
        if (!mounted) {
          return Future.value();
        }
        return ref
            .read(conversationTimelineViewModelProvider(identity).notifier)
            .recoverLatestAfterRefresh();
      },
    );
  }

  ConversationLocalSendViewportIntent _captureLocalSendViewportIntent() {
    return ref
        .read(conversationTimelineViewModelProvider(widget.identity).notifier)
        .captureLocalSendViewportIntent();
  }

  Future<void> _handleMessageSent(
    ConversationLocalSendViewportIntent viewportIntent,
  ) async {
    log(
      'surface onMessageSent: identity=${widget.identity} '
      'viewportIntent=${viewportIntent.name}',
      name: 'ConversationTimeline',
    );
    ref
        .read(conversationTimelineViewModelProvider(widget.identity).notifier)
        .applyLocalSendViewportIntent(viewportIntent);
    await widget.onMessageSent?.call();
  }

  void _handleMessageLongPress(MessageLongPressDetailsV2 details) {
    if (details.message.isDeleted) {
      return;
    }
    if (_consumeFocusedInputGesture()) {
      return;
    }
    final surfaceContext = _surfaceKey.currentContext;
    final surfaceBox = surfaceContext?.findRenderObject();
    if (surfaceBox is! RenderBox || !surfaceBox.attached) {
      return;
    }
    final surfaceGlobalOrigin = surfaceBox.localToGlobal(Offset.zero);
    final surfaceGlobalRect = surfaceGlobalOrigin & surfaceBox.size;
    final bubbleGlobalRect = details.bubbleRect;
    final visibleGlobalRect = bubbleGlobalRect.intersect(surfaceGlobalRect);
    if (visibleGlobalRect.isEmpty) {
      return;
    }
    setState(() {
      _activeOverlay = details.copyWith(
        bubbleRect: bubbleGlobalRect.shift(-surfaceGlobalOrigin),
        visibleRect: visibleGlobalRect.shift(-surfaceGlobalOrigin),
      );
    });
  }

  bool _consumeFocusedInputGesture() {
    if (_composeKey.currentState?.hasActiveInputFocus != true) {
      return false;
    }
    FocusScope.of(context).unfocus();
    _composeKey.currentState?.dismissTransientUi();
    return true;
  }

  void _dismissMessageOverlay() {
    if (_activeOverlay == null) {
      return;
    }
    setState(() {
      _activeOverlay = null;
    });
  }

  void _handleMessageVisibilityChanged(MessageVisibilityWindow? window) {
    if (_visibleMessages == window && !_isVisibilityWindowUpdateScheduled) {
      return;
    }
    _pendingVisibilityWindow = window;
    if (_isVisibilityWindowUpdateScheduled) {
      return;
    }
    _isVisibilityWindowUpdateScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _isVisibilityWindowUpdateScheduled = false;
      if (!mounted || _visibleMessages == _pendingVisibilityWindow) {
        return;
      }
      setState(() {
        _visibleMessages = _pendingVisibilityWindow;
      });
    });
  }

  Future<void> _toggleReaction(
    ConversationMessageV2 message,
    String emoji,
  ) async {
    try {
      await ref
          .read(conversationTimelineViewModelProvider(widget.identity).notifier)
          .toggleReaction(message, emoji);
    } catch (error) {
      if (!mounted) {
        return;
      }
      _showErrorDialog('$error');
    }
  }

  Future<void> _deleteMessage(ConversationMessageV2 message) async {
    try {
      await ref
          .read(conversationTimelineViewModelProvider(widget.identity).notifier)
          .deleteMessage(message);
    } catch (error) {
      if (!mounted) {
        return;
      }
      _showErrorDialog('$error');
    }
  }

  Future<void> _pinMessage(ConversationMessageV2 message) async {
    final messageId = message.serverMessageId;
    if (messageId == null) {
      return;
    }
    try {
      await ref
          .read(pinnedMessagesProvider(widget.identity).notifier)
          .pinMessage(messageId);
    } catch (error) {
      if (!mounted) {
        return;
      }
      _showErrorDialog('$error');
    }
  }

  Future<void> _unpinMessage(
    PinnedMessage pin, {
    bool optimistic = false,
    bool refreshAfter = false,
    bool rethrowError = false,
  }) async {
    try {
      await ref
          .read(pinnedMessagesProvider(widget.identity).notifier)
          .unpin(pin, optimistic: optimistic, refreshAfter: refreshAfter);
    } catch (error) {
      if (!mounted) {
        return;
      }
      _showErrorDialog('$error');
      if (rethrowError) {
        rethrow;
      }
    }
  }

  void _confirmPinMessage(ConversationMessageV2 message) {
    final l10n = AppLocalizations.of(context)!;
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: Text(l10n.pinMessageTitle),
        content: Text(l10n.pinMessageBody),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(context),
            child: Text(l10n.cancel),
          ),
          CupertinoDialogAction(
            onPressed: () {
              Navigator.pop(context);
              unawaited(_pinMessage(message));
            },
            child: Text(l10n.pinMessage),
          ),
        ],
      ),
    );
  }

  void _confirmUnpinMessage(
    PinnedMessage pin, {
    bool optimistic = false,
    bool refreshAfter = false,
  }) {
    final l10n = AppLocalizations.of(context)!;
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: Text(l10n.unpinMessageTitle),
        content: Text(l10n.unpinMessageBody),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(context),
            child: Text(l10n.cancel),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () {
              Navigator.pop(context);
              unawaited(
                _unpinMessage(
                  pin,
                  optimistic: optimistic,
                  refreshAfter: refreshAfter,
                ),
              );
            },
            child: Text(l10n.unpinMessage),
          ),
        ],
      ),
    );
  }

  void _confirmDelete(ConversationMessageV2 message) {
    final l10n = AppLocalizations.of(context)!;
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: Text(l10n.deleteMessageTitle),
        content: Text(l10n.deleteMessageBody),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(context),
            child: Text(l10n.cancel),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () {
              Navigator.pop(context);
              unawaited(_deleteMessage(message));
            },
            child: Text(l10n.deleteMessageAction),
          ),
        ],
      ),
    );
  }

  void _showErrorDialog(String message) {
    final l10n = AppLocalizations.of(context)!;
    showCupertinoDialog<void>(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: Text(l10n.error),
        content: Text(message),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(context),
            child: Text(l10n.ok),
          ),
        ],
      ),
    );
  }

  List<MessageOverlayActionV2> _overlayActions(ConversationMessageV2 message) {
    final l10n = AppLocalizations.of(context)!;
    final currentUserId = ref.read(authSessionProvider).currentUserId;
    final isOwn = message.sender.uid == currentUserId;
    final canManagePins = _canManagePins;
    final pinnedPin = _pinForMessage(message);
    final copyText = switch (message.content) {
      TextMessageContent(:final text) when text.trim().isNotEmpty => text,
      _ => null,
    };
    final composerNotifier = ref.read(
      conversationComposerViewModelProvider(widget.identity).notifier,
    );
    return <MessageOverlayActionV2>[
      MessageOverlayActionV2(
        label: l10n.reply,
        icon: CupertinoIcons.reply,
        onPressed: () {
          _dismissMessageOverlay();
          composerNotifier.beginReply(message);
        },
      ),
      if (copyText != null)
        MessageOverlayActionV2(
          label: l10n.copyMessageAction,
          icon: CupertinoIcons.doc_on_doc,
          onPressed: () {
            _dismissMessageOverlay();
            unawaited(Clipboard.setData(ClipboardData(text: copyText)));
          },
        ),
      if (_canStartThreadFrom(message))
        MessageOverlayActionV2(
          label: l10n.startThread,
          icon: CupertinoIcons.chat_bubble_2,
          onPressed: () {
            _dismissMessageOverlay();
            widget.onStartThread!(message);
          },
        ),
      if (canManagePins && _canPinMessage(message))
        MessageOverlayActionV2(
          label: pinnedPin == null ? l10n.pinMessage : l10n.unpinMessage,
          icon: pinnedPin == null ? CupertinoIcons.pin : CupertinoIcons.xmark,
          onPressed: () {
            _dismissMessageOverlay();
            if (pinnedPin == null) {
              _confirmPinMessage(message);
            } else {
              _confirmUnpinMessage(pinnedPin);
            }
          },
        ),
      if (isOwn && message.content is! AudioMessageContent)
        MessageOverlayActionV2(
          label: l10n.edit,
          icon: CupertinoIcons.pencil,
          onPressed: () {
            _dismissMessageOverlay();
            composerNotifier.clearAttachments();
            composerNotifier.beginEdit(message);
          },
        ),
      if (isOwn)
        MessageOverlayActionV2(
          label: l10n.deleteMessageAction,
          icon: CupertinoIcons.delete,
          onPressed: () {
            _dismissMessageOverlay();
            _confirmDelete(message);
          },
        ),
    ];
  }

  bool _canStartThreadFrom(ConversationMessageV2 message) {
    return widget.identity.threadRootId == null &&
        widget.onStartThread != null &&
        message.serverMessageId != null &&
        message.threadInfo == null;
  }

  bool _canPinMessage(ConversationMessageV2 message) {
    return widget.identity.threadRootId == null &&
        message.serverMessageId != null &&
        !message.isDeleted &&
        message.content is! SystemMessageContent;
  }

  bool get _canManagePins {
    if (widget.identity.threadRootId != null) {
      return false;
    }
    final metadata = ref
        .watch(
          groupMetadataViewModelProvider(widget.identity.chatId.toString()),
        )
        .value;
    return metadata?.myRole?.toLowerCase() == 'admin';
  }

  PinnedMessage? _pinForMessage(ConversationMessageV2 message) {
    final messageId = message.serverMessageId;
    if (messageId == null) {
      return null;
    }
    final pins = ref.watch(pinnedMessagesProvider(widget.identity)).value;
    if (pins == null) {
      return null;
    }
    for (final pin in pins) {
      if (pin.messageId == messageId) {
        return pin;
      }
    }
    return null;
  }

  PinnedMessage? _activePin(List<PinnedMessage> pins) {
    if (pins.isEmpty) {
      return null;
    }
    final firstVisibleMessageId = _visibleMessages?.firstVisibleMessageId;
    if (firstVisibleMessageId == null) {
      return pins.first;
    }
    for (final pin in pins) {
      final pinMessageId = pin.messageId;
      if (pinMessageId != null && pinMessageId <= firstVisibleMessageId) {
        return pin;
      }
    }
    return pins.last;
  }

  void _openPinnedMessage(PinnedMessage pin) {
    final messageId = pin.messageId;
    if (messageId == null) {
      return;
    }
    ref
        .read(conversationTimelineViewModelProvider(widget.identity).notifier)
        .jumpToMessageServerId(messageId, highlight: true);
  }

  void _showPinnedMessageList({
    required List<PinnedMessage> pins,
    required bool canManagePins,
  }) {
    showCupertinoModalPopup<void>(
      context: context,
      builder: (context) => PinnedMessageListModal(
        pins: pins,
        canManagePins: canManagePins,
        onOpenPin: (pin) {
          Navigator.pop(context);
          _openPinnedMessage(pin);
        },
        onConfirmUnpin: (pin) async {
          await _unpinMessage(
            pin,
            optimistic: true,
            refreshAfter: true,
            rethrowError: true,
          );
        },
        onOpenThread: widget.onOpenThread == null
            ? null
            : (pin) {
                Navigator.pop(context);
                widget.onOpenThread!(pin.message);
              },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;
    final isThreadView = widget.identity.threadRootId != null;
    final canManagePins = _canManagePins;
    final pins = ref.watch(pinnedMessagesProvider(widget.identity)).value;
    final activePin = pins == null ? null : _activePin(pins);

    return ConversationPresentationScope(
      isThreadView: isThreadView,
      child: GestureDetector(
        onTap: () {
          FocusScope.of(context).unfocus();
          _composeKey.currentState?.dismissTransientUi();
        },
        child: Stack(
          key: _surfaceKey,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (activePin != null && pins != null)
                  PinnedMessageBanner(
                    pin: activePin,
                    pinCount: pins.length,
                    canManagePins: canManagePins,
                    onOpenPin: () => _openPinnedMessage(activePin),
                    onOpenPinList: () => _showPinnedMessageList(
                      pins: pins,
                      canManagePins: canManagePins,
                    ),
                    onUnpin: () => _confirmUnpinMessage(activePin),
                    onOpenThread:
                        activePin.message.threadInfo != null &&
                            (activePin.message.threadInfo?.replyCount ?? 0) >
                                0 &&
                            widget.onOpenThread != null
                        ? () => widget.onOpenThread!(activePin.message)
                        : null,
                  ),
                Expanded(
                  child: Container(
                    color: colors.chatBackground,
                    child: ConversationTimelineView(
                      chatId: widget.identity.chatId,
                      threadRootId: widget.identity.threadRootId,
                      launchRequest: widget.launchRequest,
                      onOpenThread: widget.onOpenThread,
                      onStartThread: widget.onStartThread,
                      onMessageLongPress: _handleMessageLongPress,
                      onMessageVisibilityChanged:
                          _handleMessageVisibilityChanged,
                    ),
                  ),
                ),
                ConversationComposeV2(
                  key: _composeKey,
                  identity: widget.identity,
                  onMessageWillSend: _captureLocalSendViewportIntent,
                  onMessageSent: _handleMessageSent,
                ),
              ],
            ),
            if (_activeOverlay case final overlay?)
              MessageOverlayV2(
                details: overlay,
                visible: true,
                actions: _overlayActions(overlay.message),
                quickReactionEmojis: _quickReactionEmojis,
                onDismiss: _dismissMessageOverlay,
                onToggleReaction: (emoji) {
                  _dismissMessageOverlay();
                  unawaited(_toggleReaction(overlay.message, emoji));
                },
              ),
          ],
        ),
      ),
    );
  }
}
