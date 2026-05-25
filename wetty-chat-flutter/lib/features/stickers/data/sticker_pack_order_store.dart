import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:chahua/core/api/services/sticker_api_service.dart';
import '../../../core/api/models/websocket_api_models.dart';
import '../../../core/preferences/app_preferences.dart';
import '../../../core/providers/shared_preferences_provider.dart';

class StickerPackOrderItem {
  const StickerPackOrderItem({
    required this.stickerPackId,
    required this.lastUsedOn,
  });

  final String stickerPackId;

  /// Unix timestamp in milliseconds.
  final int lastUsedOn;

  Map<String, dynamic> toJson() => {
    'stickerPackId': stickerPackId,
    'lastUsedOn': lastUsedOn,
  };

  factory StickerPackOrderItem.fromJson(Map<String, dynamic> json) =>
      StickerPackOrderItem(
        stickerPackId: json['stickerPackId'] as String,
        lastUsedOn: json['lastUsedOn'] as int,
      );
}

class StickerPackOrderState {
  const StickerPackOrderState({
    this.packOrder = const [],
    this.autoSortEnabled = false,
  });

  final List<StickerPackOrderItem> packOrder;
  final bool autoSortEnabled;

  StickerPackOrderState copyWith({
    List<StickerPackOrderItem>? packOrder,
    bool? autoSortEnabled,
  }) => StickerPackOrderState(
    packOrder: packOrder ?? this.packOrder,
    autoSortEnabled: autoSortEnabled ?? this.autoSortEnabled,
  );
}

class StickerPackOrderNotifier extends Notifier<StickerPackOrderState> {
  static const _orderKey = 'sticker_pack_order';
  static const _autoSortKey = 'sticker_auto_sort_enabled';

  late AppPreferences _prefs;

  @override
  StickerPackOrderState build() {
    _prefs = ref.read(sharedPreferencesProvider);
    return _loadFromPrefs();
  }

  StickerPackOrderState _loadFromPrefs() {
    final orderJson = _prefs.getString(_orderKey);
    final autoSort = _prefs.getBool(_autoSortKey) ?? false;
    List<StickerPackOrderItem> order = const [];
    if (orderJson != null) {
      final decoded = jsonDecode(orderJson) as List;
      order = decoded
          .map((e) => StickerPackOrderItem.fromJson(e as Map<String, dynamic>))
          .toList();
    }
    return StickerPackOrderState(packOrder: order, autoSortEnabled: autoSort);
  }

  void _persistOrder() {
    final json = jsonEncode(state.packOrder.map((e) => e.toJson()).toList());
    _prefs.setString(_orderKey, json);
  }

  void _persistAutoSort() {
    _prefs.setBool(_autoSortKey, state.autoSortEnabled);
  }

  void setAutoSortEnabled(bool enabled) {
    state = state.copyWith(autoSortEnabled: enabled);
    _persistAutoSort();
  }

  void upsertPackOrder(String packId, int lastUsedOn) {
    final current = [...state.packOrder];
    final idx = current.indexWhere((e) => e.stickerPackId == packId);
    final item = StickerPackOrderItem(
      stickerPackId: packId,
      lastUsedOn: lastUsedOn,
    );
    if (idx >= 0) {
      current[idx] = item;
    } else {
      current.add(item);
    }
    state = state.copyWith(packOrder: current);
    _persistOrder();
  }

  void removePackOrder(String packId) {
    final updated = state.packOrder
        .where((e) => e.stickerPackId != packId)
        .toList();
    state = state.copyWith(packOrder: updated);
    _persistOrder();
  }

  void replaceOrderFromWs(List<StickerPackOrderItem> order) {
    state = state.copyWith(packOrder: order);
    _persistOrder();
  }

  /// Syncs current order to the backend API.
  Future<void> syncToServer() async {
    final api = ref.read(stickerApiServiceProvider);
    final dtoOrder = state.packOrder
        .map(
          (e) => StickerPackOrderItemDto(
            stickerPackId: e.stickerPackId,
            lastUsedOn: e.lastUsedOn,
          ),
        )
        .toList();
    try {
      await api.saveStickerPackOrder(dtoOrder);
    } catch (e, st) {
      debugPrint('Failed to sync sticker pack order: $e');
      debugPrint('$st');
    }
  }
}

final stickerPackOrderProvider =
    NotifierProvider<StickerPackOrderNotifier, StickerPackOrderState>(
      StickerPackOrderNotifier.new,
    );
