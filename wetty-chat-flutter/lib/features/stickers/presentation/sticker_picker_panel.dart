import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/style_config.dart';
import 'package:chahua/features/shared/model/message/message.dart';
import 'package:chahua/features/shared/presentation/sticker_image_widget.dart';
import '../application/sticker_picker_view_model.dart';
import 'sticker_pack_tab_bar.dart';
import 'widgets/sticker_grid_layout.dart';

/// Panel that displays a sticker picker grid with a pack tab bar.
///
/// Designed to sit at the bottom of the conversation screen, similar to a
/// keyboard. Fixed height of 260px.
class StickerPickerPanel extends ConsumerStatefulWidget {
  const StickerPickerPanel({
    super.key,
    required this.onStickerSelected,
    this.onClose,
  });

  final ValueChanged<StickerSummary> onStickerSelected;
  final VoidCallback? onClose;

  @override
  ConsumerState<StickerPickerPanel> createState() => _StickerPickerPanelState();
}

class _StickerPickerPanelState extends ConsumerState<StickerPickerPanel> {
  @override
  void initState() {
    super.initState();
    Future(() {
      final notifier = ref.read(stickerPickerViewModelProvider.notifier);
      notifier.loadPacks();
      notifier.loadFavorites();
    });
  }

  @override
  Widget build(BuildContext context) {
    final pickerState = ref.watch(stickerPickerViewModelProvider);
    final colors = context.appColors;

    return Container(
      height: 260,
      decoration: BoxDecoration(
        color: colors.backgroundSecondary,
        border: Border(top: BorderSide(color: colors.separator, width: 0.5)),
      ),
      child: Column(
        children: [
          Expanded(child: _buildStickerGrid(pickerState, colors)),
          StickerPackTabBar(
            packs: pickerState.packs,
            selectedPackId: pickerState.selectedPackId,
            onPackSelected: _onPackSelected,
          ),
        ],
      ),
    );
  }

  Widget _buildStickerGrid(
    StickerPickerState pickerState,
    AppColorTheme colors,
  ) {
    if (pickerState.isLoadingPacks || pickerState.isLoadingCurrentStickers) {
      return const Center(child: CupertinoActivityIndicator());
    }

    final stickers = pickerState.currentStickers;
    if (stickers.isEmpty) {
      return Center(
        child: Text(
          'No stickers',
          style: appBodyTextStyle(context, color: colors.textSecondary),
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final layout = StickerGridLayout.fromWidth(
          constraints.maxWidth,
          horizontalPadding: 8,
          crossAxisSpacing: 4,
        );

        return GridView.builder(
          padding: const EdgeInsets.all(8),
          gridDelegate: layout.buildDelegate(mainAxisSpacing: 4),
          itemCount: stickers.length,
          itemBuilder: (context, index) {
            final sticker = stickers[index];
            return _StickerGridCell(
              key: ValueKey('picker-sticker-${sticker.id}'),
              sticker: sticker,
              onTap: () {
                final packId = pickerState.selectedPackId;
                if (packId != null) {
                  ref
                      .read(stickerPickerViewModelProvider.notifier)
                      .recordStickerUsage(packId);
                }
                widget.onStickerSelected(sticker);
              },
            );
          },
        );
      },
    );
  }

  void _onPackSelected(String? packId) {
    final notifier = ref.read(stickerPickerViewModelProvider.notifier);
    if (packId == null) {
      notifier.selectFavorites();
    } else {
      notifier.selectPack(packId);
    }
  }
}

class _StickerGridCell extends StatefulWidget {
  const _StickerGridCell({
    super.key,
    required this.sticker,
    required this.onTap,
  });

  final StickerSummary sticker;
  final VoidCallback onTap;

  @override
  State<_StickerGridCell> createState() => _StickerGridCellState();
}

class _StickerGridCellState extends State<_StickerGridCell>
    with SingleTickerProviderStateMixin {
  static const Duration _previewDuration = Duration(milliseconds: 180);

  late final AnimationController _previewController;
  OverlayEntry? _previewEntry;
  Rect? _sourceRect;
  Rect? _targetRect;

  @override
  void initState() {
    super.initState();
    _previewController = AnimationController(
      vsync: this,
      duration: _previewDuration,
      reverseDuration: const Duration(milliseconds: 140),
    );
  }

  @override
  void dispose() {
    _previewEntry?.remove();
    _previewController.dispose();
    super.dispose();
  }

  void _showPreview() {
    final overlay = Overlay.of(context);
    final renderObject = context.findRenderObject();
    final overlayRenderObject = overlay.context.findRenderObject();
    if (renderObject is! RenderBox || overlayRenderObject is! RenderBox) {
      return;
    }

    final sourceTopLeft = overlayRenderObject.globalToLocal(
      renderObject.localToGlobal(Offset.zero),
    );
    final sourceRect = sourceTopLeft & renderObject.size;
    final overlaySize = overlayRenderObject.size;
    final previewSize = (overlaySize.shortestSide * 0.58)
        .clamp(180.0, 300.0)
        .toDouble();
    final targetRect = Rect.fromCenter(
      center: overlaySize.center(Offset.zero),
      width: previewSize,
      height: previewSize,
    );

    _sourceRect = sourceRect;
    _targetRect = targetRect;
    _previewEntry ??= OverlayEntry(builder: _buildPreviewOverlay);
    if (!_previewEntry!.mounted) {
      overlay.insert(_previewEntry!);
    }
    _previewController.forward(from: 0);
  }

  void _hidePreview() {
    if (_previewEntry == null) {
      return;
    }
    _previewController.reverse().whenComplete(() {
      _previewEntry?.remove();
      _previewEntry = null;
      _sourceRect = null;
      _targetRect = null;
    });
  }

  Widget _buildPreviewOverlay(BuildContext context) {
    final colors = context.appColors;
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: _previewController,
        builder: (context, child) {
          final curved = Curves.easeOutCubic.transform(
            _previewController.value,
          );
          final rect = Rect.lerp(_sourceRect, _targetRect, curved);
          if (rect == null) {
            return const SizedBox.shrink();
          }

          return Stack(
            children: [
              Positioned.fill(
                child: ColoredBox(
                  color: CupertinoColors.black.withAlpha((curved * 72).round()),
                ),
              ),
              Positioned.fromRect(
                rect: rect,
                child: DecoratedBox(
                  key: ValueKey('picker-sticker-preview-${widget.sticker.id}'),
                  decoration: BoxDecoration(
                    color: colors.backgroundSecondary,
                    borderRadius: BorderRadius.circular(18),
                    boxShadow: [
                      BoxShadow(
                        color: CupertinoColors.black.withAlpha(45),
                        blurRadius: 28,
                        offset: const Offset(0, 14),
                      ),
                    ],
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: StickerImage(
                      media: widget.sticker.media,
                      emoji: widget.sticker.emoji,
                      size: rect.width - 36,
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: widget.onTap,
      onLongPressStart: (_) => _showPreview(),
      onLongPressEnd: (_) => _hidePreview(),
      onLongPressCancel: _hidePreview,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final imageSize = (constraints.maxWidth - 8).clamp(
            0.0,
            double.infinity,
          );
          return Center(
            child: StickerImage(
              media: widget.sticker.media,
              emoji: widget.sticker.emoji,
              size: imageSize,
            ),
          );
        },
      ),
    );
  }
}
