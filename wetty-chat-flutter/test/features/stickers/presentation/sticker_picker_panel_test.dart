import 'package:dio/dio.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:chahua/core/api/services/sticker_api_service.dart';
import 'package:chahua/core/api/models/messages_api_models.dart';
import 'package:chahua/core/api/models/stickers_api_models.dart';
import 'package:chahua/core/providers/shared_preferences_provider.dart';
import 'package:chahua/features/stickers/presentation/sticker_picker_panel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('picker uses responsive layout on wider widths', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues(const <String, Object>{});
    final preferences = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        stickerApiServiceProvider.overrideWithValue(
          _FakeStickerApiService(
            favorites: List.generate(5, (index) => _stickerDto('s$index')),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: CupertinoApp(
          home: CupertinoPageScaffold(
            child: SafeArea(
              child: StickerPickerPanel(onStickerSelected: (_) {}),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final firstSticker = find.byKey(const ValueKey('picker-sticker-s0'));
    final fifthSticker = find.byKey(const ValueKey('picker-sticker-s4'));

    expect(firstSticker, findsOneWidget);
    expect(fifthSticker, findsOneWidget);

    final firstSize = tester.getSize(firstSticker);
    expect(firstSize.width, closeTo(firstSize.height, 0.01));
    expect(firstSize.width, lessThanOrEqualTo(88));
    expect(
      tester.getTopLeft(fifthSticker).dy,
      closeTo(tester.getTopLeft(firstSticker).dy, 0.01),
    );
  });

  testWidgets('long press opens enlarged sticker preview only', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues(const <String, Object>{});
    final preferences = await SharedPreferences.getInstance();
    final stickers = List.generate(3, (index) => _stickerDto('s$index'));
    final stickerApiService = _FakeStickerApiService(favorites: stickers);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        stickerApiServiceProvider.overrideWithValue(stickerApiService),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: CupertinoApp(
          home: CupertinoPageScaffold(
            child: SafeArea(
              child: StickerPickerPanel(onStickerSelected: (_) {}),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('picker-sticker-s0'))),
    );
    await tester.pump(kLongPressTimeout);
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('picker-sticker-preview-s0')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('preview-sticker-s0')), findsNothing);
    expect(find.text('Add to Favorites'), findsNothing);
    expect(stickerApiService.fetchStickerDetailCount, 0);
    expect(stickerApiService.fetchPackDetailCount, 0);

    await gesture.up();
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('picker-sticker-preview-s0')),
      findsNothing,
    );
  });
}

class _FakeStickerApiService extends StickerApiService {
  _FakeStickerApiService({required this.favorites}) : super(Dio());

  final List<StickerSummaryDto> favorites;
  int fetchStickerDetailCount = 0;
  int fetchPackDetailCount = 0;

  @override
  Future<StickerPackListResponseDto> fetchOwnedPacks() async {
    return const StickerPackListResponseDto();
  }

  @override
  Future<StickerPackListResponseDto> fetchSubscribedPacks() async {
    return const StickerPackListResponseDto();
  }

  @override
  Future<FavoriteStickerListResponseDto> fetchFavorites() async {
    return FavoriteStickerListResponseDto(stickers: favorites);
  }

  @override
  Future<StickerDetailResponseDto> fetchStickerDetail(String stickerId) async {
    fetchStickerDetailCount += 1;
    return StickerDetailResponseDto(
      id: stickerId,
      emoji: '😀',
      media: StickerMediaDto(id: 'media-$stickerId', url: ''),
      packs: [
        const StickerPackSummaryDto(id: 'pack-1', ownerUid: 1, name: 'Pack'),
      ],
    );
  }

  @override
  Future<StickerPackDetailResponseDto> fetchPackDetail(String packId) async {
    fetchPackDetailCount += 1;
    return StickerPackDetailResponseDto(
      id: packId,
      ownerUid: 1,
      name: 'Pack',
      stickers: favorites,
    );
  }

  @override
  Future<void> saveStickerPackOrder(List<dynamic> order) async {}
}

StickerSummaryDto _stickerDto(String id) {
  return StickerSummaryDto(
    id: id,
    emoji: '😀',
    media: StickerMediaDto(id: 'media-$id', url: ''),
  );
}
