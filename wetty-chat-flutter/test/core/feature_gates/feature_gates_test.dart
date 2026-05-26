import 'package:chahua/core/feature_gates/feature_gates.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('featureGateProvider', () {
    test('uses the gate default when no override is provided', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final enabled = container.read(
        featureGateProvider(AppFeatureGate.messageSearchInlineTags),
      );

      expect(enabled, kDebugMode);
    });

    test('can disable a debug-default gate with an explicit override', () {
      final container = ProviderContainer(
        overrides: [
          featureGateConfigProvider.overrideWithValue(
            const FeatureGateConfig(
              overrides: {AppFeatureGate.messageSearchInlineTags: false},
            ),
          ),
        ],
      );
      addTearDown(container.dispose);

      final enabled = container.read(
        featureGateProvider(AppFeatureGate.messageSearchInlineTags),
      );

      expect(enabled, isFalse);
    });

    test('can enable a gate with an explicit override', () {
      final container = ProviderContainer(
        overrides: [
          featureGateConfigProvider.overrideWithValue(
            const FeatureGateConfig(
              overrides: {AppFeatureGate.messageSearchInlineTags: true},
            ),
          ),
        ],
      );
      addTearDown(container.dispose);

      final enabled = container.read(
        featureGateProvider(AppFeatureGate.messageSearchInlineTags),
      );

      expect(enabled, isTrue);
    });
  });
}
