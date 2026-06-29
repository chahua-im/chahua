import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/features/conversation/compose/presentation/conversation_composer_view_model.dart';
import 'package:chahua/features/conversation/compose/data/attachment_picker_service.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/conversation/shared/domain/conversation_identity.dart';
import 'package:chahua/features/conversation/timeline/presentation/conversation_timeline_view_model.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_attachment_menu.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_audio_controls.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_input_area.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_mention_autocomplete.dart';
import 'package:chahua/features/conversation/compose/presentation/composer_mentions.dart';
import 'package:chahua/features/groups/members/data/group_member_models.dart';
import 'package:chahua/features/groups/members/data/group_member_repository.dart';
import 'package:chahua/l10n/app_localizations.dart';

class ConversationV2ComposerBar extends ConsumerStatefulWidget {
  const ConversationV2ComposerBar({
    super.key,
    required this.identity,
    this.onMessageWillSend,
    this.onMessageSent,
    this.onToggleStickerPicker,
    this.onInputFocusChanged,
    this.isStickerPickerOpen = false,
  });

  final ConversationIdentity identity;
  final ConversationLocalSendViewportIntent Function()? onMessageWillSend;
  final Future<void> Function(ConversationLocalSendViewportIntent intent)?
  onMessageSent;
  final VoidCallback? onToggleStickerPicker;
  final ValueChanged<bool>? onInputFocusChanged;
  final bool isStickerPickerOpen;

  @override
  ConsumerState<ConversationV2ComposerBar> createState() =>
      _ConversationV2ComposerBarState();
}

class _ConversationV2ComposerBarState
    extends ConsumerState<ConversationV2ComposerBar> {
  static const double _audioGestureThreshold = 26;
  static const double _composerActionButtonSize = 36;
  static const double _composerActionSlotWidth = 48;
  static const double _composerFieldMinHeight = 36;
  static const double _audioGestureTargetGap = 18;
  static const int _mentionLimit = 8;
  static const Duration _mentionDebounceDuration = Duration(milliseconds: 250);
  static const Key _mentionAutocompleteKey = ValueKey(
    'composer-mention-autocomplete',
  );
  static const Key _composerInputChromeKey = ValueKey('composer-input-chrome');

  final ScrollController _inputScrollController = ScrollController();
  final TextEditingController _textController = TextEditingController();
  final FocusNode _inputFocusNode = FocusNode();
  final LayerLink _attachmentMenuLink = LayerLink();

  ProviderSubscription<ConversationComposerState>? _composerSubscription;
  bool _isAttachmentPanelOpen = false;
  OverlayEntry? _attachmentMenuEntry;
  int? _activeAudioPointerId;
  Offset? _audioPointerOrigin;
  ComposerAudioSnapPosition _audioSnapPosition =
      ComposerAudioSnapPosition.origin;
  Offset _audioDragOffset = Offset.zero;
  Timer? _mentionDebounceTimer;
  int _mentionLookupVersion = 0;
  int _mentionSelectionRevision = 0;
  int? _mentionTriggerStart;
  bool _mentionLoading = false;
  String _mentionQuery = '';
  List<GroupMember> _mentionResults = const <GroupMember>[];
  List<ComposerMentionEntry> _mentionEntries = const <ComposerMentionEntry>[];

  void _resetAudioGestureState() {
    _activeAudioPointerId = null;
    _audioPointerOrigin = null;
    _audioSnapPosition = ComposerAudioSnapPosition.origin;
    _audioDragOffset = Offset.zero;
  }

  bool get _showMentionAutocomplete =>
      _inputFocusNode.hasFocus &&
      (_mentionLoading || _mentionResults.isNotEmpty);

  void _clearMentionState({
    bool clearEntries = false,
    bool clearQuery = true,
    bool closeSuggestions = true,
  }) {
    _mentionDebounceTimer?.cancel();
    _mentionDebounceTimer = null;
    _mentionLookupVersion += 1;
    if (closeSuggestions) {
      _mentionResults = const <GroupMember>[];
      _mentionLoading = false;
      _mentionTriggerStart = null;
    }
    if (clearQuery) {
      _mentionQuery = '';
    }
    if (clearEntries) {
      _mentionEntries = const <ComposerMentionEntry>[];
    }
  }

  void _handleInputFocusChanged() {
    widget.onInputFocusChanged?.call(_inputFocusNode.hasFocus);
    if (_inputFocusNode.hasFocus) {
      _refreshMentionSuggestions();
      return;
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _clearMentionState(closeSuggestions: true, clearQuery: true);
    });
  }

  void _handleTextControllerChanged() {
    if (!mounted) {
      return;
    }

    final retainedEntries = retainValidMentionEntries(
      _textController.text,
      _mentionEntries,
    );
    final changed = retainedEntries.length != _mentionEntries.length;

    if (changed) {
      setState(() {
        _mentionEntries = retainedEntries;
      });
    }

    _refreshMentionSuggestions();
  }

  void _refreshMentionSuggestions() {
    final selection = _textController.selection;
    if (!_inputFocusNode.hasFocus ||
        !selection.isValid ||
        !selection.isCollapsed) {
      if (!mounted) {
        return;
      }
      setState(() {
        _clearMentionState(closeSuggestions: true, clearQuery: true);
      });
      return;
    }

    final trigger = detectMentionTrigger(
      _textController.text,
      selection.extentOffset,
    );
    if (trigger == null) {
      if (!mounted) {
        return;
      }
      setState(() {
        _clearMentionState(closeSuggestions: true, clearQuery: true);
      });
      return;
    }

    final queryChanged =
        trigger.query != _mentionQuery ||
        trigger.triggerStart != _mentionTriggerStart;
    if (!queryChanged) {
      return;
    }

    setState(() {
      _mentionQuery = trigger.query;
      _mentionTriggerStart = trigger.triggerStart;
      _mentionResults = const <GroupMember>[];
      _mentionLoading = true;
    });
    _mentionDebounceTimer?.cancel();
    _mentionDebounceTimer = Timer(
      _mentionDebounceDuration,
      () => unawaited(_loadMentionSuggestions(trigger.query)),
    );
  }

  Future<void> _loadMentionSuggestions(String query) async {
    final lookupVersion = ++_mentionLookupVersion;
    try {
      final page = await ref
          .read(groupMemberRepositoryProvider)
          .fetchMembers(
            widget.identity.chatId.toString(),
            limit: _mentionLimit,
            query: query,
            searchMode: GroupMemberSearchMode.autocomplete,
          );
      if (!mounted ||
          lookupVersion != _mentionLookupVersion ||
          query != _mentionQuery) {
        return;
      }
      setState(() {
        _mentionResults = page.members;
        _mentionLoading = false;
      });
    } catch (_) {
      if (!mounted ||
          lookupVersion != _mentionLookupVersion ||
          query != _mentionQuery) {
        return;
      }
      setState(() {
        _mentionResults = const <GroupMember>[];
        _mentionLoading = false;
      });
    }
  }

  Future<void> _selectMention(GroupMember member) async {
    final triggerStart = _mentionTriggerStart;
    final selection = _textController.selection;
    if (triggerStart == null || !selection.isValid || !selection.isCollapsed) {
      return;
    }

    final username = member.username?.trim().isNotEmpty == true
        ? member.username!.trim()
        : 'User ${member.uid}';
    final displayMention = '@$username';
    final before = _textController.text.substring(0, triggerStart);
    final after = _textController.text.substring(selection.extentOffset);
    final inserted = '$displayMention ';
    final nextText = '$before$inserted$after';
    final nextCursorOffset = triggerStart + inserted.length;

    _mentionSelectionRevision += 1;
    final selectionRevision = _mentionSelectionRevision;
    _textController.value = TextEditingValue(
      text: nextText,
      selection: TextSelection.collapsed(offset: nextCursorOffset),
    );
    _inputFocusNode.requestFocus();

    final nextEntry = ComposerMentionEntry(
      uid: member.uid,
      username: username,
      start: triggerStart,
      end: triggerStart + displayMention.length,
    );

    if (!mounted || selectionRevision != _mentionSelectionRevision) {
      return;
    }

    setState(() {
      _mentionEntries = retainValidMentionEntries(nextText, [
        ..._mentionEntries,
        nextEntry,
      ]);
      _clearMentionState(closeSuggestions: true, clearQuery: true);
    });

    await ref
        .read(conversationComposerViewModelProvider(widget.identity).notifier)
        .updateDraft(nextText);
  }

  String _wireFormatText(String text) {
    final trimmed = text.trim();
    return convertComposerMentionsToWireFormat(trimmed, _mentionEntries);
  }

  Future<void> _hydrateEditingMentions(ConversationComposerState next) async {
    final mode = next.mode;
    if (mode is! ComposerEditing) {
      return;
    }

    final hydrated = hydrateComposerMentions(
      switch (mode.message.content) {
        TextMessageContent(:final text) => text,
        AudioMessageContent(:final text) => text ?? '',
        InviteMessageContent(:final text) => text ?? '',
        SystemMessageContent(:final text) => text,
        StickerMessageContent() => '',
        ForwardedMessageContent() => '',
      },
      switch (mode.message.content) {
        TextMessageContent(:final mentions) => mentions,
        AudioMessageContent(:final mentions) => mentions,
        InviteMessageContent(:final mentions) => mentions,
        _ => const <MentionInfo>[],
      },
    );
    _textController.value = TextEditingValue(
      text: hydrated.text,
      selection: TextSelection.collapsed(offset: hydrated.text.length),
    );
    if (!mounted) {
      return;
    }
    setState(() {
      _mentionEntries = hydrated.entries;
      _clearMentionState(closeSuggestions: true, clearQuery: true);
    });
    await ref
        .read(conversationComposerViewModelProvider(widget.identity).notifier)
        .updateDraft(hydrated.text);
  }

  @override
  void initState() {
    super.initState();
    _textController.addListener(_handleTextControllerChanged);
    _inputFocusNode.addListener(_handleInputFocusChanged);
    _composerSubscription = ref.listenManual<ConversationComposerState>(
      conversationComposerViewModelProvider(widget.identity),
      (previous, next) {
        _syncControllerText(next.draft);
        if (_isAttachmentPanelOpen &&
            (next.isEditing || next.isAtAttachmentLimit)) {
          _closeAttachmentMenu();
        }
        if (next.mode is ComposerEditing && previous?.mode != next.mode) {
          unawaited(_hydrateEditingMentions(next));
          return;
        }
        if (next.draft.isEmpty && previous?.draft.isNotEmpty == true) {
          setState(() {
            _clearMentionState(clearEntries: true);
          });
        }
      },
      fireImmediately: true,
    );
  }

  @override
  void dispose() {
    _closeAttachmentMenu(updateState: false);
    _mentionDebounceTimer?.cancel();
    _composerSubscription?.close();
    _textController.removeListener(_handleTextControllerChanged);
    _inputFocusNode.removeListener(_handleInputFocusChanged);
    _inputScrollController.dispose();
    _textController.dispose();
    _inputFocusNode.dispose();
    super.dispose();
  }

  void _syncControllerText(String draft) {
    if (_textController.text == draft) {
      return;
    }
    _textController.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  Future<void> _sendMessage() async {
    final composer = ref.read(
      conversationComposerViewModelProvider(widget.identity),
    );
    final composeViewModel = ref.read(
      conversationComposerViewModelProvider(widget.identity).notifier,
    );
    if (composer.isEditing && composer.attachments.isNotEmpty) {
      _showErrorDialog('Editing does not support attachments yet.');
      return;
    }
    if (_textController.text.trim().isEmpty &&
        !composer.hasUploadedAttachments) {
      return;
    }
    final viewportIntent = widget.onMessageWillSend?.call();
    try {
      await composeViewModel.send(text: _wireFormatText(_textController.text));
      _closeAttachmentMenu();
      _textController.clear();
      if (mounted) {
        setState(() {
          _clearMentionState(clearEntries: true);
        });
      }
      if (viewportIntent != null) {
        unawaited(widget.onMessageSent?.call(viewportIntent));
      }
    } catch (error) {
      if (mounted) {
        _showErrorDialog('$error');
      }
    }
  }

  Future<void> _sendRecordedAudio() async {
    final composerNotifier = ref.read(
      conversationComposerViewModelProvider(widget.identity).notifier,
    );
    final viewportIntent = widget.onMessageWillSend?.call();
    try {
      await composerNotifier.sendRecordedAudio();
      _closeAttachmentMenu();
      if (viewportIntent != null) {
        await widget.onMessageSent?.call(viewportIntent);
      }
    } on ComposerAudioException catch (error) {
      if (mounted) {
        _showErrorDialog(_audioErrorMessage(error));
      }
    } catch (error) {
      if (mounted) {
        _showErrorDialog('$error');
      }
    }
  }

  Future<void> _pickAttachments(ComposerAttachmentSource source) async {
    try {
      final message = await ref
          .read(conversationComposerViewModelProvider(widget.identity).notifier)
          .pickAndQueueAttachments(source);
      _closeAttachmentMenu();
      if (!mounted || message == null) {
        return;
      }
      _showErrorDialog(message);
    } catch (error) {
      if (mounted) {
        _showErrorDialog('$error');
      }
    }
  }

  void _toggleStickerPicker() {
    if (_isAttachmentPanelOpen) {
      _closeAttachmentMenu();
    }
    widget.onToggleStickerPicker?.call();
  }

  void _toggleAttachmentPanel() {
    if (_isAttachmentPanelOpen) {
      _closeAttachmentMenu();
      return;
    }
    if (widget.isStickerPickerOpen) {
      widget.onToggleStickerPicker?.call();
    }
    _openAttachmentMenu();
  }

  void _openAttachmentMenu() {
    final overlay = Overlay.of(context);
    _attachmentMenuEntry?.remove();
    _attachmentMenuEntry = OverlayEntry(
      builder: (overlayContext) {
        final screenWidth = MediaQuery.sizeOf(overlayContext).width;
        final maxWidth = screenWidth * 0.54;
        return Stack(
          children: [
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.translucent,
                onTap: _closeAttachmentMenu,
              ),
            ),
            CompositedTransformFollower(
              link: _attachmentMenuLink,
              showWhenUnlinked: false,
              targetAnchor: Alignment.bottomLeft,
              followerAnchor: Alignment.bottomLeft,
              offset: const Offset(0, 0),
              child: Padding(
                padding: const EdgeInsets.only(right: 16),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minWidth: 176,
                    maxWidth: maxWidth.clamp(176, 236),
                  ),
                  child: ComposerAttachmentMenu(
                    onPickAttachments: _pickAttachments,
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
    overlay.insert(_attachmentMenuEntry!);
    if (mounted) {
      setState(() {
        _isAttachmentPanelOpen = true;
      });
    }
  }

  void _closeAttachmentMenu({bool updateState = true}) {
    _attachmentMenuEntry?.remove();
    _attachmentMenuEntry = null;
    if (updateState && mounted && _isAttachmentPanelOpen) {
      setState(() {
        _isAttachmentPanelOpen = false;
      });
    } else if (!updateState) {
      _isAttachmentPanelOpen = false;
    }
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

  String _audioErrorMessage(ComposerAudioException error) {
    final l10n = AppLocalizations.of(context)!;
    return switch (error.code) {
      ComposerAudioErrorCode.unsupported => l10n.voiceRecordingUnsupported,
      ComposerAudioErrorCode.permissionDenied =>
        l10n.voiceMicrophonePermissionDenied,
      ComposerAudioErrorCode.tooShort => l10n.voiceRecordingTooShort,
      ComposerAudioErrorCode.startFailed => l10n.voiceRecordingStartFailed,
      ComposerAudioErrorCode.uploadFailed => l10n.voiceMessageUploadFailed,
    };
  }

  ComposerAudioSnapPosition _resolveAudioSnapPosition(Offset currentPosition) {
    final origin = _audioPointerOrigin;
    if (origin == null) {
      return ComposerAudioSnapPosition.origin;
    }
    final dx = currentPosition.dx - origin.dx;
    final dy = currentPosition.dy - origin.dy;
    final leftProgress = -dx;
    final upProgress = -dy;
    final axis = _resolveAudioDragAxis(dx, dy);

    return switch (axis) {
      ComposerAudioDragAxis.horizontal =>
        leftProgress >= _audioGestureThreshold
            ? ComposerAudioSnapPosition.left
            : ComposerAudioSnapPosition.origin,
      ComposerAudioDragAxis.vertical =>
        upProgress >= _audioGestureThreshold
            ? ComposerAudioSnapPosition.top
            : ComposerAudioSnapPosition.origin,
      ComposerAudioDragAxis.undecided => ComposerAudioSnapPosition.origin,
    };
  }

  Future<void> _handleAudioPointerDown(PointerDownEvent event) async {
    if (_activeAudioPointerId != null) {
      return;
    }
    if (widget.isStickerPickerOpen) {
      widget.onToggleStickerPicker?.call();
    }
    if (_isAttachmentPanelOpen) {
      _closeAttachmentMenu();
    }
    _activeAudioPointerId = event.pointer;
    _audioPointerOrigin = event.position;
    setState(() {
      _audioSnapPosition = ComposerAudioSnapPosition.origin;
      _audioDragOffset = Offset.zero;
    });
    try {
      await ref
          .read(conversationComposerViewModelProvider(widget.identity).notifier)
          .startAudioRecording();
    } on ComposerAudioException catch (error) {
      _resetAudioGestureState();
      if (mounted) {
        _showErrorDialog(_audioErrorMessage(error));
      }
    } catch (error) {
      _resetAudioGestureState();
      if (mounted) {
        _showErrorDialog('$error');
      }
    }
  }

  void _handleAudioPointerMove(PointerMoveEvent event) {
    if (_activeAudioPointerId != event.pointer) {
      return;
    }
    final visualOffset = _resolveAudioDragOffset(event.position);
    final next = _resolveAudioSnapPosition(event.position);
    if (next == _audioSnapPosition && visualOffset == _audioDragOffset) {
      return;
    }
    setState(() {
      _audioDragOffset = visualOffset;
      _audioSnapPosition = next;
    });
  }

  Offset _resolveAudioDragOffset(Offset currentPosition) {
    final origin = _audioPointerOrigin;
    if (origin == null) {
      return Offset.zero;
    }
    final maxOffset = _composerActionButtonSize + _audioGestureTargetGap;
    final dx = currentPosition.dx - origin.dx;
    final dy = currentPosition.dy - origin.dy;
    final nextAxis = _resolveAudioDragAxis(dx, dy);

    return switch (nextAxis) {
      ComposerAudioDragAxis.horizontal => Offset(dx.clamp(-maxOffset, 0.0), 0),
      ComposerAudioDragAxis.vertical => Offset(0, dy.clamp(-maxOffset, 0.0)),
      ComposerAudioDragAxis.undecided => Offset.zero,
    };
  }

  ComposerAudioDragAxis _resolveAudioDragAxis(double dx, double dy) {
    final leftProgress = -dx;
    final upProgress = -dy;
    final crossedLeft = leftProgress >= _audioGestureThreshold;
    final crossedTop = upProgress >= _audioGestureThreshold;

    if (!crossedLeft && !crossedTop) {
      return ComposerAudioDragAxis.undecided;
    }
    return leftProgress >= upProgress
        ? ComposerAudioDragAxis.horizontal
        : ComposerAudioDragAxis.vertical;
  }

  Future<void> _finalizeAudioGesture(ComposerAudioSnapPosition position) async {
    final composerNotifier = ref.read(
      conversationComposerViewModelProvider(widget.identity).notifier,
    );
    try {
      switch (position) {
        case ComposerAudioSnapPosition.left:
          await composerNotifier.cancelAudioRecording();
          break;
        case ComposerAudioSnapPosition.top:
          await composerNotifier.finishAudioRecording();
          await _sendRecordedAudio();
          break;
        case ComposerAudioSnapPosition.origin:
          await composerNotifier.finishAudioRecording();
          break;
      }
    } on ComposerAudioException catch (error) {
      if (mounted) {
        _showErrorDialog(_audioErrorMessage(error));
      }
    } catch (error) {
      if (mounted) {
        _showErrorDialog('$error');
      }
    } finally {
      if (mounted) {
        setState(() {
          _resetAudioGestureState();
        });
      } else {
        _resetAudioGestureState();
      }
    }
  }

  Future<void> _handleAudioPointerFinish(PointerEvent event) async {
    if (_activeAudioPointerId != event.pointer) {
      return;
    }
    await _finalizeAudioGesture(_resolveAudioSnapPosition(event.position));
  }

  bool _isRecordingPhase(ConversationComposerState composer) {
    final draft = composer.audioDraft;
    if (draft == null) {
      return false;
    }
    return draft.phase == ComposerAudioDraftPhase.requestingPermission ||
        draft.phase == ComposerAudioDraftPhase.recording;
  }

  bool _isSavedDraftPhase(ConversationComposerState composer) {
    final draft = composer.audioDraft;
    if (draft == null) {
      return false;
    }
    return draft.phase == ComposerAudioDraftPhase.recorded ||
        draft.phase == ComposerAudioDraftPhase.uploading;
  }

  @override
  Widget build(BuildContext context) {
    final composer = ref.watch(
      conversationComposerViewModelProvider(widget.identity),
    );
    final colors = context.appColors;
    final selectionLocked = composer.isAtAttachmentLimit;
    final canAttach =
        !composer.isEditing &&
        !selectionLocked &&
        !composer.hasAudioDraft &&
        !composer.hasPendingAudioRecording;
    final isRecordingPhase = _isRecordingPhase(composer);
    final isSavedDraftPhase = _isSavedDraftPhase(composer);
    final showAudioRecordButton =
        !composer.canSend && (composer.canStartAudio || isRecordingPhase);
    final showAudioTargets = _activeAudioPointerId != null;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_showMentionAutocomplete)
          Padding(
            key: _mentionAutocompleteKey,
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: ComposerMentionAutocomplete(
              results: _mentionResults,
              loading: _mentionLoading,
              onSelect: (member) {
                unawaited(_selectMention(member));
              },
            ),
          ),
        Padding(
          key: _composerInputChromeKey,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Opacity(
                opacity: selectionLocked ? 0.45 : 1,
                child: CompositedTransformTarget(
                  link: _attachmentMenuLink,
                  child: SizedBox(
                    width: 36,
                    height: 36,
                    child: CupertinoButton(
                      padding: EdgeInsets.zero,
                      minimumSize: const Size(36, 36),
                      onPressed: canAttach ? _toggleAttachmentPanel : null,
                      child: Icon(
                        CupertinoIcons.add_circled,
                        color: canAttach
                            ? CupertinoColors.activeBlue.resolveFrom(context)
                            : CupertinoColors.systemGrey2.resolveFrom(context),
                        size: 28,
                      ),
                    ),
                  ),
                ),
              ),
              if (composer.hasPendingAttachmentUploads)
                const Padding(
                  padding: EdgeInsets.only(left: 4, bottom: 2),
                  child: CupertinoActivityIndicator(radius: 8),
                ),
              const SizedBox(width: 4),
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: colors.inputBorder),
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(19),
                    child: ColoredBox(
                      color: colors.backgroundSecondary,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          ComposerPreviewBar(
                            composer: composer,
                            onClearMode: () {
                              final notifier = ref.read(
                                conversationComposerViewModelProvider(
                                  widget.identity,
                                ).notifier,
                              );
                              if (composer.mode is ComposerEditing) {
                                unawaited(notifier.cancelEdit());
                                return;
                              }
                              notifier.clearMode();
                            },
                          ),
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Expanded(
                                child: ComposerInputArea(
                                  composer: composer,
                                  textController: _textController,
                                  focusNode: _inputFocusNode,
                                  inputScrollController: _inputScrollController,
                                  snapPosition: _audioSnapPosition,
                                  fieldMinHeight: _composerFieldMinHeight,
                                  onRemoveAttachment: (localId) {
                                    ref
                                        .read(
                                          conversationComposerViewModelProvider(
                                            widget.identity,
                                          ).notifier,
                                        )
                                        .removeAttachment(localId);
                                  },
                                  onRetryAttachment: (localId) {
                                    return ref
                                        .read(
                                          conversationComposerViewModelProvider(
                                            widget.identity,
                                          ).notifier,
                                        )
                                        .retryAttachment(localId);
                                  },
                                  onDeleteAudioDraft: () {
                                    return ref
                                        .read(
                                          conversationComposerViewModelProvider(
                                            widget.identity,
                                          ).notifier,
                                        )
                                        .cancelAudioRecording();
                                  },
                                  onToggleStickerPicker: _toggleStickerPicker,
                                  isStickerPickerOpen:
                                      widget.isStickerPickerOpen,
                                  onDraftChanged: (value) {
                                    unawaited(
                                      ref
                                          .read(
                                            conversationComposerViewModelProvider(
                                              widget.identity,
                                            ).notifier,
                                          )
                                          .updateDraft(value),
                                    );
                                  },
                                  onSend: () {
                                    return _sendMessage();
                                  },
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 4),
              ComposerAudioControls(
                showAudioRecordButton: showAudioRecordButton,
                showAudioTargets: showAudioTargets,
                isSavedDraftPhase: isSavedDraftPhase,
                snapPosition: _audioSnapPosition,
                dragOffset: _audioDragOffset,
                composer: composer,
                buttonSize: _composerActionButtonSize,
                slotWidth: _composerActionSlotWidth,
                onSendRecordedAudio: showAudioRecordButton || isSavedDraftPhase
                    ? _sendRecordedAudio
                    : _sendMessage,
                onAudioPointerDown: _handleAudioPointerDown,
                onAudioPointerMove: _handleAudioPointerMove,
                onAudioPointerFinish: _handleAudioPointerFinish,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
