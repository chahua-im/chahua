import 'dart:developer' as developer;
import 'dart:ui' as ui;

import 'package:chahua/app/theme/style_config.dart';
import 'package:chahua/core/settings/app_settings_store.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class CjkTextDiagnosticsPage extends ConsumerStatefulWidget {
  const CjkTextDiagnosticsPage({super.key});

  @override
  ConsumerState<CjkTextDiagnosticsPage> createState() =>
      _CjkTextDiagnosticsPageState();
}

class _CjkTextDiagnosticsPageState
    extends ConsumerState<CjkTextDiagnosticsPage> {
  static const String _sampleText =
      '②即使是学习本身也是可耻的，学习不重要，学英语不是为了会英语，'
      '而是为了能拿到一张英语考试证书来方便升学。';
  static const String _mixedText =
      'Mixed: English ABC, 中文汉字, zh-Hans/zh-Hant, URL chahua.app, 13:58';
  static const String _glyphVariantText = '骨 直 草 门 門 国 國 里 裡';

  static const List<_LocaleProbe> _probes = [
    _LocaleProbe('Inherited locale', null),
    _LocaleProbe('English en', ui.Locale('en')),
    _LocaleProbe('Chinese zh', ui.Locale('zh')),
    _LocaleProbe(
      'Chinese Hans',
      ui.Locale.fromSubtags(languageCode: 'zh', scriptCode: 'Hans'),
    ),
    _LocaleProbe(
      'Chinese Hant',
      ui.Locale.fromSubtags(languageCode: 'zh', scriptCode: 'Hant'),
    ),
    _LocaleProbe('Chinese zh_CN', ui.Locale('zh', 'CN')),
    _LocaleProbe('Chinese zh_TW', ui.Locale('zh', 'TW')),
    _LocaleProbe('Japanese ja', ui.Locale('ja')),
  ];

  static const List<_WeightProbe> _weights = [
    _WeightProbe('w400', AppFontWeights.regular),
    _WeightProbe('w500', AppFontWeights.medium),
    _WeightProbe('w600', AppFontWeights.semibold),
  ];

  static const List<_FontFamilyProbe> _fontFamilyProbes = [
    _FontFamilyProbe('Platform fallback'),
    _FontFamilyProbe('CupertinoSystemText', fontFamily: 'CupertinoSystemText'),
    _FontFamilyProbe('PingFang SC family', fontFamily: 'PingFang SC'),
    _FontFamilyProbe('PingFang TC family', fontFamily: 'PingFang TC'),
    _FontFamilyProbe('PingFang HK family', fontFamily: 'PingFang HK'),
    _FontFamilyProbe('MiSans bundled', fontFamily: 'MiSans'),
    _FontFamilyProbe(
      'Fallback: PingFang SC',
      fontFamilyFallback: ['PingFang SC'],
    ),
    _FontFamilyProbe(
      'Fallback: PingFang TC',
      fontFamilyFallback: ['PingFang TC'],
    ),
    _FontFamilyProbe(
      'System + PingFang SC',
      fontFamily: 'CupertinoSystemText',
      fontFamilyFallback: ['PingFang SC'],
    ),
    _FontFamilyProbe(
      'System + MiSans',
      fontFamily: 'CupertinoSystemText',
      fontFamilyFallback: ['MiSans'],
    ),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        _logLocaleState();
      }
    });
  }

  void _logLocaleState() {
    final settings = ref.read(appSettingsProvider);
    final localizationsLocale = Localizations.localeOf(context);
    final dispatcher = WidgetsBinding.instance.platformDispatcher;
    final mediaQuery = MediaQuery.of(context);
    developer.log(
      [
        'appSetting=${settings.language.name}',
        'appLocale=${settings.language.toLocale()}',
        'localizationsLocale=$localizationsLocale',
        'platformLocale=${dispatcher.locale}',
        'platformLocales=${dispatcher.locales}',
        'textScaler=${mediaQuery.textScaler}',
        'boldText=${mediaQuery.boldText}',
      ].join(' | '),
      name: 'wetty.text_diag',
    );
  }

  @override
  Widget build(BuildContext context) {
    final settings = ref.watch(appSettingsProvider);
    final dispatcher = WidgetsBinding.instance.platformDispatcher;
    final localizationsLocale = Localizations.localeOf(context);
    return CupertinoPageScaffold(
      backgroundColor: CupertinoColors.systemGroupedBackground,
      navigationBar: const CupertinoNavigationBar(
        middle: Text('CJK Text Diagnostics'),
      ),
      child: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          children: [
            _InfoCard(
              rows: [
                ('App setting', settings.language.name),
                ('App locale', '${settings.language.toLocale()}'),
                ('Resolved locale', '$localizationsLocale'),
                ('Platform locale', '${dispatcher.locale}'),
                ('Platform locales', '${dispatcher.locales}'),
                ('Bold text', '${MediaQuery.boldTextOf(context)}'),
                ('Text scaler', '${MediaQuery.textScalerOf(context)}'),
              ],
            ),
            const SizedBox(height: 16),
            const _FontFamilyProbeSection(),
            const SizedBox(height: 16),
            for (final probe in _probes) ...[
              _LocaleProbeCard(probe: probe),
              const SizedBox(height: 16),
            ],
          ],
        ),
      ),
    );
  }
}

class _FontFamilyProbeSection extends StatelessWidget {
  const _FontFamilyProbeSection();

  static const ui.Locale _probeLocale = ui.Locale.fromSubtags(
    languageCode: 'zh',
    scriptCode: 'Hans',
  );

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemBackground.resolveFrom(context),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Font Family Probes (zh_Hans)',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.body,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Same text and locale; only fontFamily/fontFamilyFallback changes.',
              style: appSecondaryTextStyle(
                context,
                fontSize: AppFontSizes.meta,
              ),
            ),
            const SizedBox(height: 10),
            for (final fontProbe
                in _CjkTextDiagnosticsPageState._fontFamilyProbes) ...[
              _FontFamilyProbeCard(fontProbe: fontProbe, locale: _probeLocale),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }
}

class _FontFamilyProbeCard extends StatelessWidget {
  const _FontFamilyProbeCard({required this.fontProbe, required this.locale});

  final _FontFamilyProbe fontProbe;
  final ui.Locale locale;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(
          color: CupertinoColors.separator.resolveFrom(context),
        ),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              fontProbe.label,
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.meta,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 8),
            for (final weight in _CjkTextDiagnosticsPageState._weights) ...[
              _BubbleProbe(
                probe: _LocaleProbe('zh_Hans', locale),
                weight: weight,
                text: _CjkTextDiagnosticsPageState._sampleText,
                fontProbe: fontProbe,
              ),
              const SizedBox(height: 8),
            ],
            _DiagnosticTextLine(
              probe: _LocaleProbe('zh_Hans', locale),
              text: _CjkTextDiagnosticsPageState._glyphVariantText,
              fontProbe: fontProbe,
            ),
          ],
        ),
      ),
    );
  }
}

class _LocaleProbeCard extends StatelessWidget {
  const _LocaleProbeCard({required this.probe});

  final _LocaleProbe probe;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemBackground.resolveFrom(context),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${probe.label} (${probe.locale ?? 'ambient'})',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.body,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 10),
            for (final weight in _CjkTextDiagnosticsPageState._weights) ...[
              _BubbleProbe(
                probe: probe,
                weight: weight,
                text: _CjkTextDiagnosticsPageState._sampleText,
              ),
              const SizedBox(height: 8),
            ],
            const SizedBox(height: 4),
            _DiagnosticTextLine(
              probe: probe,
              text: _CjkTextDiagnosticsPageState._mixedText,
            ),
            const SizedBox(height: 6),
            _DiagnosticTextLine(
              probe: probe,
              text: _CjkTextDiagnosticsPageState._glyphVariantText,
            ),
          ],
        ),
      ),
    );
  }
}

class _BubbleProbe extends StatelessWidget {
  const _BubbleProbe({
    required this.probe,
    required this.weight,
    required this.text,
    this.fontProbe,
  });

  final _LocaleProbe probe;
  final _WeightProbe weight;
  final String text;
  final _FontFamilyProbe? fontProbe;

  @override
  Widget build(BuildContext context) {
    final colors = context.appColors;
    final bodyStyle =
        appBubbleTextStyle(
          context,
          color: colors.textPrimary,
          fontSize: AppSettingsNotifier.defaultChatMessageFontSize,
          fontWeight: weight.weight,
          height: 1.28,
        ).copyWith(
          fontFamily: fontProbe?.fontFamily,
          fontFamilyFallback: fontProbe?.fontFamilyFallback,
          locale: probe.locale,
        );
    final metaStyle =
        appBubbleMetaTextStyle(
          context,
          color: colors.chatReceivedMeta,
          fontSize: AppFontSizes.caption,
          fontWeight: AppFontWeights.regular,
        ).copyWith(
          fontFamily: fontProbe?.fontFamily,
          fontFamilyFallback: fontProbe?.fontFamilyFallback,
          locale: probe.locale,
        );

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.chatReceivedBubble,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Text.rich(
          TextSpan(
            children: [
              TextSpan(text: '${weight.label}  ', style: metaStyle),
              TextSpan(text: text, style: bodyStyle),
              const WidgetSpan(child: SizedBox(width: 36, height: 14)),
              TextSpan(text: '13:58', style: metaStyle),
            ],
          ),
          locale: probe.locale,
        ),
      ),
    );
  }
}

class _DiagnosticTextLine extends StatelessWidget {
  const _DiagnosticTextLine({
    required this.probe,
    required this.text,
    this.fontProbe,
  });

  final _LocaleProbe probe;
  final String text;
  final _FontFamilyProbe? fontProbe;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        text: text,
        style:
            appTextStyle(
              context,
              fontSize: AppFontSizes.body,
              fontWeight: AppFontWeights.medium,
            ).copyWith(
              fontFamily: fontProbe?.fontFamily,
              fontFamilyFallback: fontProbe?.fontFamilyFallback,
              locale: probe.locale,
            ),
      ),
      locale: probe.locale,
    );
  }
}

class _InfoCard extends StatelessWidget {
  const _InfoCard({required this.rows});

  final List<(String, String)> rows;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: CupertinoColors.systemBackground.resolveFrom(context),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Current Locale State',
              style: appTextStyle(
                context,
                fontSize: AppFontSizes.body,
                fontWeight: AppFontWeights.semibold,
              ),
            ),
            const SizedBox(height: 8),
            for (final row in rows)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  '${row.$1}: ${row.$2}',
                  style: appSecondaryTextStyle(
                    context,
                    fontSize: AppFontSizes.meta,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _LocaleProbe {
  const _LocaleProbe(this.label, this.locale);

  final String label;
  final ui.Locale? locale;
}

class _WeightProbe {
  const _WeightProbe(this.label, this.weight);

  final String label;
  final FontWeight weight;
}

class _FontFamilyProbe {
  const _FontFamilyProbe(
    this.label, {
    this.fontFamily,
    this.fontFamilyFallback,
  });

  final String label;
  final String? fontFamily;
  final List<String>? fontFamilyFallback;
}
