import 'package:chahua/core/platform/native_dialog_focus_guard.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('prepareForNativeDialog clears focus and hides input on iOS', (
    tester,
  ) async {
    final focusNode = FocusNode();
    addTearDown(focusNode.dispose);
    final events = <String>[];

    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Focus(autofocus: true, focusNode: focusNode, child: SizedBox()),
      ),
    );
    await tester.pump();

    expect(focusNode.hasFocus, isTrue);

    await NativeDialogFocusGuard(
      platform: TargetPlatform.iOS,
      hideTextInput: () async => events.add('hide'),
      waitForEndOfFrame: () async => events.add('wait'),
    ).prepareForNativeDialog();

    expect(focusNode.hasFocus, isFalse);
    expect(events, <String>['hide', 'wait']);
  });

  testWidgets('prepareForNativeDialog leaves non-iOS focus untouched', (
    tester,
  ) async {
    final focusNode = FocusNode();
    addTearDown(focusNode.dispose);
    final events = <String>[];

    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: Focus(autofocus: true, focusNode: focusNode, child: SizedBox()),
      ),
    );
    await tester.pump();

    expect(focusNode.hasFocus, isTrue);

    await NativeDialogFocusGuard(
      platform: TargetPlatform.android,
      hideTextInput: () async => events.add('hide'),
      waitForEndOfFrame: () async => events.add('wait'),
    ).prepareForNativeDialog();

    expect(focusNode.hasFocus, isTrue);
    expect(events, isEmpty);
  });
}
