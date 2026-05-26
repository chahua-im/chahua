import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Named feature gates used to keep experimental UI behind a stable seam.
enum AppFeatureGate {
  /// Enables UI-only inline tags in message search.
  messageSearchInlineTags(
    defaultEnabled: kDebugMode,
    description: 'Shows UI-only inline tags in message search.',
  );

  const AppFeatureGate({
    required this.defaultEnabled,
    required this.description,
  });

  /// Whether the feature is enabled when no explicit override is present.
  final bool defaultEnabled;

  /// Short human-readable description for future settings or diagnostics UI.
  final String description;
}

/// Runtime feature-gate overrides.
class FeatureGateConfig {
  const FeatureGateConfig({this.overrides = const <AppFeatureGate, bool>{}});

  /// Explicit gate values that replace each gate's default.
  final Map<AppFeatureGate, bool> overrides;

  /// Returns the effective value for [gate].
  bool isEnabled(AppFeatureGate gate) {
    return overrides[gate] ?? gate.defaultEnabled;
  }
}

/// Provides the current feature-gate configuration.
final featureGateConfigProvider = Provider<FeatureGateConfig>((ref) {
  return const FeatureGateConfig();
});

/// Provides the effective enabled state for one app feature gate.
final featureGateProvider = Provider.family<bool, AppFeatureGate>((ref, gate) {
  return ref.watch(featureGateConfigProvider).isEnabled(gate);
});
