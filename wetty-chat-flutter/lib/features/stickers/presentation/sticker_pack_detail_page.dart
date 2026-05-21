import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/core/platform/native_dialog_focus_guard.dart';

import '../../../app/theme/style_config.dart';
import '../../../core/session/dev_session_store.dart';
import '../application/sticker_pack_detail_view_model.dart';
import 'add_sticker_modal.dart';
import 'widgets/add_sticker_cell.dart';
import 'widgets/sticker_grid_layout.dart';
import 'widgets/sticker_grid_item.dart';

class StickerPackDetailPage extends ConsumerStatefulWidget {
  const StickerPackDetailPage({super.key, required this.packId});

  final String packId;

  @override
  ConsumerState<StickerPackDetailPage> createState() =>
      _StickerPackDetailPageState();
}

class _StickerPackDetailPageState extends ConsumerState<StickerPackDetailPage> {
  Future<bool> _showConfirmDialog({
    required String title,
    required String message,
    required String confirmLabel,
  }) async {
    final result = await showCupertinoDialog<bool>(
      context: context,
      builder: (ctx) => CupertinoAlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          CupertinoDialogAction(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  Future<void> _confirmDeletePack() async {
    final confirmed = await _showConfirmDialog(
      title: 'Delete Pack',
      message:
          'Delete this sticker pack? Stickers will stay available elsewhere.',
      confirmLabel: 'Delete',
    );
    if (confirmed && mounted) {
      await ref
          .read(stickerPackDetailViewModelProvider(widget.packId).notifier)
          .deletePack();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _confirmUnsubscribe() async {
    final confirmed = await _showConfirmDialog(
      title: 'Unsubscribe',
      message: 'Remove this pack from your collection?',
      confirmLabel: 'Unsubscribe',
    );
    if (confirmed && mounted) {
      await ref
          .read(stickerPackDetailViewModelProvider(widget.packId).notifier)
          .unsubscribePack();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _confirmRemoveSticker(String stickerId) async {
    final confirmed = await _showConfirmDialog(
      title: 'Remove Sticker',
      message: 'Remove this sticker from the pack?',
      confirmLabel: 'Remove',
    );
    if (confirmed) {
      ref
          .read(stickerPackDetailViewModelProvider(widget.packId).notifier)
          .removeSticker(stickerId);
    }
  }

  Future<void> _pickAndAddSticker() async {
    await const NativeDialogFocusGuard().prepareForNativeDialog();
    final result = await FilePicker.pickFiles(type: FileType.image);
    if (result == null || result.files.isEmpty) return;

    final file = result.files.first;
    final filePath = file.path;
    if (filePath == null) return;

    final fileBytes = file.bytes ?? await File(filePath).readAsBytes();

    // Check size <= 10MB
    if (fileBytes.length > 10485760) {
      if (!mounted) return;
      showCupertinoDialog<void>(
        context: context,
        builder: (ctx) => CupertinoAlertDialog(
          title: const Text('File Too Large'),
          content: const Text('Sticker images must be 10 MB or smaller.'),
          actions: [
            CupertinoDialogAction(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('OK'),
            ),
          ],
        ),
      );
      return;
    }

    if (!mounted) return;
    showAddStickerPage(
      context,
      packId: widget.packId,
      filePath: filePath,
      fileName: file.name,
      fileBytes: fileBytes,
    );
  }

  @override
  Widget build(BuildContext context) {
    final asyncState = ref.watch(
      stickerPackDetailViewModelProvider(widget.packId),
    );
    final currentUserId = ref.watch(devSessionProvider);
    final colors = context.appColors;

    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        middle: asyncState.whenData((s) => s.pack.name).value != null
            ? Text(asyncState.value!.pack.name)
            : const Text('Sticker Pack'),
        trailing: asyncState.whenOrNull(
          data: (state) {
            final isOwner = state.pack.ownerUid == currentUserId;
            if (isOwner) {
              return CupertinoButton(
                padding: EdgeInsets.zero,
                onPressed: _confirmDeletePack,
                child: Text(
                  'Delete',
                  style: appBodyTextStyle(
                    context,
                    color: CupertinoColors.destructiveRed,
                  ),
                ),
              );
            }
            return CupertinoButton(
              padding: EdgeInsets.zero,
              onPressed: _confirmUnsubscribe,
              child: Text(
                'Unsubscribe',
                style: appBodyTextStyle(
                  context,
                  color: CupertinoColors.destructiveRed,
                ),
              ),
            );
          },
        ),
      ),
      child: SafeArea(
        child: asyncState.when(
          loading: () => const Center(child: CupertinoActivityIndicator()),
          error: (error, _) => Center(
            child: Text(
              'Failed to load pack details',
              style: appBodyTextStyle(context, color: colors.textSecondary),
            ),
          ),
          data: (state) {
            final isOwner = state.pack.ownerUid == currentUserId;
            final stickers = state.stickers;
            final gridItemCount = isOwner
                ? stickers.length + 1
                : stickers.length;

            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (isOwner)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 8,
                    ),
                    child: Text(
                      'Tap a sticker to remove it from this pack.',
                      style: appSecondaryTextStyle(
                        context,
                        fontSize: AppFontSizes.meta,
                      ),
                    ),
                  ),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final layout = StickerGridLayout.fromWidth(
                        constraints.maxWidth,
                        horizontalPadding: 8,
                        crossAxisSpacing: 8,
                      );

                      return GridView.builder(
                        padding: const EdgeInsets.all(8),
                        gridDelegate: layout.buildDelegate(mainAxisSpacing: 8),
                        itemCount: gridItemCount,
                        itemBuilder: (context, index) {
                          if (isOwner && index == 0) {
                            return AddStickerCell(
                              key: const Key('add-sticker-cell'),
                              onTap: _pickAndAddSticker,
                            );
                          }
                          final stickerIndex = isOwner ? index - 1 : index;
                          final sticker = stickers[stickerIndex];
                          return StickerGridItem(
                            key: ValueKey('pack-sticker-${sticker.id}'),
                            sticker: sticker,
                            onTap: isOwner
                                ? () => _confirmRemoveSticker(sticker.id)
                                : null,
                          );
                        },
                      );
                    },
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}
