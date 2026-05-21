import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Clears Flutter text input state before opening native iOS dialogs.
///
/// Flutter can currently leave iOS in a broken state when a native dialog
/// appears while a text field is focused: the keyboard returns, but Flutter
/// focus is gone and the keyboard cannot be dismissed normally.
///
/// Keep this until https://github.com/flutter/flutter/issues/150522 is fixed.
class NativeDialogFocusGuard {
  const NativeDialogFocusGuard({
    TargetPlatform? platform,
    Future<void> Function()? hideTextInput,
    Future<void> Function()? waitForEndOfFrame,
  }) : _platform = platform,
       _hideTextInput = hideTextInput,
       _waitForEndOfFrame = waitForEndOfFrame;

  final TargetPlatform? _platform;
  final Future<void> Function()? _hideTextInput;
  final Future<void> Function()? _waitForEndOfFrame;

  Future<void> prepareForNativeDialog() async {
    if ((_platform ?? defaultTargetPlatform) != TargetPlatform.iOS) {
      return;
    }

    FocusManager.instance.primaryFocus?.unfocus();
    await (_hideTextInput ?? _defaultHideTextInput)();
    await (_waitForEndOfFrame ?? _defaultWaitForEndOfFrame)();
  }

  static Future<void> _defaultHideTextInput() async {
    await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
  }

  static Future<void> _defaultWaitForEndOfFrame() async {
    await WidgetsBinding.instance.endOfFrame;
  }
}
