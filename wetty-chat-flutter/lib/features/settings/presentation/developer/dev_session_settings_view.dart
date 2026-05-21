import 'package:flutter/foundation.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'package:chahua/app/routing/route_names.dart';
import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/session/dev_session_store.dart';
import 'package:chahua/features/settings/presentation/developer/cjk_text_diagnostics_page.dart';

class DevSessionSettingsPage extends ConsumerStatefulWidget {
  const DevSessionSettingsPage({super.key});

  @override
  ConsumerState<DevSessionSettingsPage> createState() =>
      _DevSessionSettingsPageState();
}

class _DevSessionSettingsPageState
    extends ConsumerState<DevSessionSettingsPage> {
  late final TextEditingController _uidController;
  String? _errorText;
  bool _isSaving = false;

  @override
  void initState() {
    super.initState();
    _uidController = TextEditingController(
      text: ref.read(authSessionProvider).developerUserId.toString(),
    );
  }

  @override
  void dispose() {
    _uidController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final raw = _uidController.text.trim();
    final nextUserId = int.tryParse(raw);
    if (nextUserId == null || nextUserId <= 0) {
      setState(() {
        _errorText = 'Enter a valid positive UID.';
      });
      return;
    }

    setState(() {
      _isSaving = true;
      _errorText = null;
    });
    try {
      await ref.read(authSessionProvider.notifier).setCurrentUserId(nextUserId);
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop();
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  Future<void> _resetToDefault() async {
    setState(() {
      _isSaving = true;
      _errorText = null;
    });
    try {
      await ref.read(authSessionProvider.notifier).resetToDefault();
      _uidController.text = AuthSessionNotifier.defaultUserId.toString();
      if (!mounted) {
        return;
      }
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  Future<void> _clearJwt() async {
    setState(() {
      _isSaving = true;
      _errorText = null;
    });
    try {
      if (mounted) {
        context.go(AppRoutes.bootstrap);
      }
      await ref.read(authSessionProvider.notifier).clearJwt();
      if (!mounted) {
        return;
      }
    } finally {
      if (mounted) {
        setState(() {
          _isSaving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authSessionProvider);
    final modeLabel = switch (session.mode) {
      AuthSessionMode.jwt => 'JWT token',
      AuthSessionMode.devHeader => 'Developer UID header',
      AuthSessionMode.none => 'No active session',
    };
    return CupertinoPageScaffold(
      navigationBar: const CupertinoNavigationBar(
        middle: Text('Developer Session'),
      ),
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'The Flutter app supports a stored JWT session after login and '
              'the existing developer UID session. Changing the developer UID '
              'applies immediately only while the app is using developer headers.',
              style: appSecondaryTextStyle(
                context,
                fontSize: AppFontSizes.body,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Current Session',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.body,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              modeLabel,
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.chatEntryTitle,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'Active UID: ${session.currentUserId}',
              style: appSecondaryTextStyle(
                context,
                fontSize: AppFontSizes.body,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Stored JWT: ${session.hasJwtToken ? 'Present' : 'None'}',
              style: appSecondaryTextStyle(
                context,
                fontSize: AppFontSizes.body,
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'Developer UID',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.body,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              '${session.developerUserId}',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.chatEntryTitle,
              ),
            ),
            const SizedBox(height: 24),
            CupertinoTextField(
              controller: _uidController,
              keyboardType: const TextInputType.numberWithOptions(
                signed: false,
                decimal: false,
              ),
              placeholder: 'Enter UID',
              padding: const EdgeInsets.all(14),
              onChanged: (_) {
                if (_errorText != null) {
                  setState(() {
                    _errorText = null;
                  });
                }
              },
            ),
            if (_errorText != null) ...[
              const SizedBox(height: 8),
              Text(
                _errorText!,
                style: appTextStyle(
                  context,
                  fontSize: AppFontSizes.meta,
                  color: CupertinoColors.systemRed.resolveFrom(context),
                ),
              ),
            ],
            const SizedBox(height: 16),
            CupertinoButton.filled(
              onPressed: _isSaving ? null : _save,
              child: _isSaving
                  ? const CupertinoActivityIndicator(
                      color: CupertinoColors.white,
                    )
                  : const Text('Save UID'),
            ),
            const SizedBox(height: 12),
            CupertinoButton(
              onPressed: _isSaving ? null : _resetToDefault,
              child: Text('Reset to UID ${AuthSessionNotifier.defaultUserId}'),
            ),
            const SizedBox(height: 12),
            CupertinoButton(
              onPressed: _isSaving || !session.hasJwtToken ? null : _clearJwt,
              child: const Text('Clear Stored JWT'),
            ),
            if (kDebugMode) ...[
              const SizedBox(height: 24),
              CupertinoButton(
                onPressed: () {
                  Navigator.of(context).push(
                    CupertinoPageRoute<void>(
                      builder: (_) => const CjkTextDiagnosticsPage(),
                    ),
                  );
                },
                child: const Text('Open CJK Text Diagnostics'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
