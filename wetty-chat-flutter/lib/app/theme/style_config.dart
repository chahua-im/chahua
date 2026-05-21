import 'package:flutter/cupertino.dart';

class AppFontFamilies {
  const AppFontFamilies._();

  // Intentionally null so each platform can use its native font cascade.
  // On iOS this lets Apple choose SF for Latin and PingFang for CJK text.
  static const String? system = null;

  static const List<String> cjkFallback = [
    'PingFang SC',
    'PingFang TC',
    'PingFang HK',
  ];
}

class AppFontWeights {
  const AppFontWeights._();

  static const FontWeight regular = FontWeight.w400;
  static const FontWeight medium = FontWeight.w500;
  static const FontWeight semibold = FontWeight.w600;
  static const FontWeight bold = FontWeight.w700;
}

class AppFontSizes {
  const AppFontSizes._();

  static const double caption = 11;
  static const double meta = 13;
  static const double body = 14;
  static const double bodyLarge = 16;
  static const double subtitle = 17;
  static const double title = 18;

  static const double bodySmall = meta;
  static const double appTitle = title;
  static const double sectionTitle = title;
  static const double navigationTitle = title;
  static const double display = title;

  static const double chatEntryTitle = bodyLarge;
  static const double unreadBadge = caption;
  static const double bubbleText = bodyLarge;
  static const double bubbleMeta = caption;
  static const double replyQuote = 14;
}

class IconSizes {
  const IconSizes._();

  static const double iconSize = 22;
}

class AppColorThemeOverrides {
  const AppColorThemeOverrides({this.unreadBadge});

  final Color? unreadBadge;

  bool get isEmpty => unreadBadge == null;

  AppColorThemeOverrides copyWith({Object? unreadBadge = _unsetColor}) {
    return AppColorThemeOverrides(
      unreadBadge: identical(unreadBadge, _unsetColor)
          ? this.unreadBadge
          : unreadBadge as Color?,
    );
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is AppColorThemeOverrides && unreadBadge == other.unreadBadge;
  }

  @override
  int get hashCode => unreadBadge.hashCode;
}

const Object _unsetColor = Object();

class AppColorThemeScope extends InheritedWidget {
  const AppColorThemeScope({
    super.key,
    required this.overrides,
    required super.child,
  });

  final AppColorThemeOverrides overrides;

  static AppColorThemeOverrides maybeOf(BuildContext context) {
    return context
            .dependOnInheritedWidgetOfExactType<AppColorThemeScope>()
            ?.overrides ??
        const AppColorThemeOverrides();
  }

  @override
  bool updateShouldNotify(AppColorThemeScope oldWidget) {
    return overrides != oldWidget.overrides;
  }
}

class AppColorTheme {
  const AppColorTheme({
    required this.backgroundPrimary,
    required this.backgroundSecondary,
    required this.surfaceCard,
    required this.surfaceMuted,
    required this.textPrimary,
    required this.textSecondary,
    required this.textOnAccent,
    required this.separator,
    required this.accentPrimary,
    required this.unreadBadge,
    required this.unreadBadgeText,
    required this.inactive,
    required this.chatBackground,
    required this.chatSentBubble,
    required this.chatReceivedBubble,
    required this.chatSentMeta,
    required this.chatReceivedMeta,
    required this.chatLinkOnSent,
    required this.chatLinkOnReceived,
    required this.chatMessageHighlight,
    required this.chatReplyActionBackground,
    required this.chatAttachmentChipSent,
    required this.chatAttachmentChipReceived,
    required this.chatThreadChipSent,
    required this.chatThreadChipReceived,
    required this.chatReactionSent,
    required this.chatReactionSentActive,
    required this.chatReactionReceived,
    required this.chatReactionReceivedActive,
    required this.avatarBackground,
    required this.inputSurface,
    required this.inputBorder,
    required this.composerReplyPreviewSurface,
    required this.composerReplyPreviewDivider,
    required this.composerReplyPreviewTitle,
  });

  final Color backgroundPrimary;
  final Color backgroundSecondary;
  final Color surfaceCard;
  final Color surfaceMuted;
  final Color textPrimary;
  final Color textSecondary;
  final Color textOnAccent;
  final Color separator;
  final Color accentPrimary;
  final Color unreadBadge;
  final Color unreadBadgeText;
  final Color inactive;
  final Color chatBackground;
  final Color chatSentBubble;
  final Color chatReceivedBubble;
  final Color chatSentMeta;
  final Color chatReceivedMeta;
  final Color chatLinkOnSent;
  final Color chatLinkOnReceived;
  final Color chatMessageHighlight;
  final Color chatReplyActionBackground;
  final Color chatAttachmentChipSent;
  final Color chatAttachmentChipReceived;
  final Color chatThreadChipSent;
  final Color chatThreadChipReceived;
  final Color chatReactionSent;
  final Color chatReactionSentActive;
  final Color chatReactionReceived;
  final Color chatReactionReceivedActive;
  final Color avatarBackground;
  final Color inputSurface;
  final Color inputBorder;
  final Color composerReplyPreviewSurface;
  final Color composerReplyPreviewDivider;
  final Color composerReplyPreviewTitle;

  AppColorTheme copyWith({
    Color? backgroundPrimary,
    Color? backgroundSecondary,
    Color? surfaceCard,
    Color? surfaceMuted,
    Color? textPrimary,
    Color? textSecondary,
    Color? textOnAccent,
    Color? separator,
    Color? accentPrimary,
    Color? unreadBadge,
    Color? unreadBadgeText,
    Color? inactive,
    Color? chatBackground,
    Color? chatSentBubble,
    Color? chatReceivedBubble,
    Color? chatSentMeta,
    Color? chatReceivedMeta,
    Color? chatLinkOnSent,
    Color? chatLinkOnReceived,
    Color? chatMessageHighlight,
    Color? chatReplyActionBackground,
    Color? chatAttachmentChipSent,
    Color? chatAttachmentChipReceived,
    Color? chatThreadChipSent,
    Color? chatThreadChipReceived,
    Color? chatReactionSent,
    Color? chatReactionSentActive,
    Color? chatReactionReceived,
    Color? chatReactionReceivedActive,
    Color? avatarBackground,
    Color? inputSurface,
    Color? inputBorder,
    Color? composerReplyPreviewSurface,
    Color? composerReplyPreviewDivider,
    Color? composerReplyPreviewTitle,
  }) {
    final resolvedUnreadBadge = unreadBadge ?? this.unreadBadge;
    return AppColorTheme(
      backgroundPrimary: backgroundPrimary ?? this.backgroundPrimary,
      backgroundSecondary: backgroundSecondary ?? this.backgroundSecondary,
      surfaceCard: surfaceCard ?? this.surfaceCard,
      surfaceMuted: surfaceMuted ?? this.surfaceMuted,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textOnAccent: textOnAccent ?? this.textOnAccent,
      separator: separator ?? this.separator,
      accentPrimary: accentPrimary ?? this.accentPrimary,
      unreadBadge: resolvedUnreadBadge,
      unreadBadgeText:
          unreadBadgeText ??
          (unreadBadge == null
              ? this.unreadBadgeText
              : badgeTextColorFor(resolvedUnreadBadge)),
      inactive: inactive ?? this.inactive,
      chatBackground: chatBackground ?? this.chatBackground,
      chatSentBubble: chatSentBubble ?? this.chatSentBubble,
      chatReceivedBubble: chatReceivedBubble ?? this.chatReceivedBubble,
      chatSentMeta: chatSentMeta ?? this.chatSentMeta,
      chatReceivedMeta: chatReceivedMeta ?? this.chatReceivedMeta,
      chatLinkOnSent: chatLinkOnSent ?? this.chatLinkOnSent,
      chatLinkOnReceived: chatLinkOnReceived ?? this.chatLinkOnReceived,
      chatMessageHighlight: chatMessageHighlight ?? this.chatMessageHighlight,
      chatReplyActionBackground:
          chatReplyActionBackground ?? this.chatReplyActionBackground,
      chatAttachmentChipSent:
          chatAttachmentChipSent ?? this.chatAttachmentChipSent,
      chatAttachmentChipReceived:
          chatAttachmentChipReceived ?? this.chatAttachmentChipReceived,
      chatThreadChipSent: chatThreadChipSent ?? this.chatThreadChipSent,
      chatThreadChipReceived:
          chatThreadChipReceived ?? this.chatThreadChipReceived,
      chatReactionSent: chatReactionSent ?? this.chatReactionSent,
      chatReactionSentActive:
          chatReactionSentActive ?? this.chatReactionSentActive,
      chatReactionReceived: chatReactionReceived ?? this.chatReactionReceived,
      chatReactionReceivedActive:
          chatReactionReceivedActive ?? this.chatReactionReceivedActive,
      avatarBackground: avatarBackground ?? this.avatarBackground,
      inputSurface: inputSurface ?? this.inputSurface,
      inputBorder: inputBorder ?? this.inputBorder,
      composerReplyPreviewSurface:
          composerReplyPreviewSurface ?? this.composerReplyPreviewSurface,
      composerReplyPreviewDivider:
          composerReplyPreviewDivider ?? this.composerReplyPreviewDivider,
      composerReplyPreviewTitle:
          composerReplyPreviewTitle ?? this.composerReplyPreviewTitle,
    );
  }

  static AppColorTheme resolve({
    required Brightness brightness,
    required AppColorThemeOverrides overrides,
  }) {
    final defaults = brightness == Brightness.dark
        ? AppColorTheme.darkDefaults
        : AppColorTheme.lightDefaults;
    return defaults.copyWith(unreadBadge: overrides.unreadBadge);
  }

  static Color badgeTextColorFor(Color background) {
    return background.computeLuminance() > 0.5
        ? CupertinoColors.black
        : CupertinoColors.white;
  }

  static const lightDefaults = AppColorTheme(
    backgroundPrimary: Color(0xFFF0F0F0),
    backgroundSecondary: Color(0xFFFFFFFF),
    surfaceCard: Color(0xFFFFFFFF),
    surfaceMuted: Color(0xFFF3F4F6),
    textPrimary: CupertinoColors.black,
    textSecondary: Color(0xFF6B7280),
    textOnAccent: CupertinoColors.white,
    separator: Color(0xFFDADDE3),
    accentPrimary: Color(0xFF2B7ACD),
    unreadBadge: Color(0xFFE05144),
    unreadBadgeText: CupertinoColors.white,
    inactive: Color(0xFF8E8E93),
    chatBackground: Color.from(
      alpha: 1.0,
      red: 0.921,
      green: 0.898,
      blue: 0.871,
    ),
    chatSentBubble: Color(0xFF2B7ACD),
    chatReceivedBubble: Color(0xFFF0F0F0),
    chatSentMeta: Color(0xD6FFFFFF),
    chatReceivedMeta: Color(0xFF6B7280),
    chatLinkOnSent: Color(0xFFD9EBFF),
    chatLinkOnReceived: Color(0xFF2B7ACD),
    chatMessageHighlight: Color(0x55FFD65A),
    chatReplyActionBackground: Color(0xFFE9EDF3),
    chatAttachmentChipSent: Color(0xFFDCEBFF),
    chatAttachmentChipReceived: Color(0xFFF1EAE3),
    chatThreadChipSent: Color(0xFFDCEBFF),
    chatThreadChipReceived: Color(0xFFF1EAE3),
    chatReactionSent: Color(0xFF7BAEE5),
    chatReactionSentActive: Color(0xFF1F69B5),
    chatReactionReceived: Color(0xFFF3F4F6),
    chatReactionReceivedActive: Color(0xFFCFE1F6),
    avatarBackground: Color(0xFFD1D5DB),
    inputSurface: Color(0xFFF3F4F6),
    inputBorder: Color(0xFFD1D5DB),
    composerReplyPreviewSurface: Color(0xFFF0F0F0),
    composerReplyPreviewDivider: Color(0xFFE0E0E0),
    composerReplyPreviewTitle: Color(0xFF2B7ACD),
  );

  static const darkDefaults = AppColorTheme(
    backgroundPrimary: Color(0xFF111214),
    backgroundSecondary: Color(0xFF18191C),
    surfaceCard: Color(0xFF1C1C1E),
    surfaceMuted: Color(0xFF2C2C2E),
    textPrimary: CupertinoColors.white,
    textSecondary: Color(0xFFAEAEB2),
    textOnAccent: CupertinoColors.white,
    separator: Color(0xFF3A3A3C),
    accentPrimary: Color(0xFF2B7ACD),
    unreadBadge: Color(0xFFE05144),
    unreadBadgeText: CupertinoColors.white,
    inactive: Color(0xFF8E8E93),
    chatBackground: Color(0xFF000000),
    chatSentBubble: Color(0xFF2B7ACD),
    chatReceivedBubble: Color(0xFF1C1C1E),
    chatSentMeta: Color(0xBEFFFFFF),
    chatReceivedMeta: Color(0xFFAEAEB2),
    chatLinkOnSent: Color(0xFFD9EBFF),
    chatLinkOnReceived: Color(0xFF66A8FF),
    chatMessageHighlight: Color(0x4DF4C542),
    chatReplyActionBackground: Color(0xFF2C3440),
    chatAttachmentChipSent: Color(0xFF1C4FA3),
    chatAttachmentChipReceived: Color(0xFF35363A),
    chatThreadChipSent: Color(0xFF1C4FA3),
    chatThreadChipReceived: Color(0xFF35363A),
    chatReactionSent: Color(0xFF3E7FC9),
    chatReactionSentActive: Color(0xFF1C4FA3),
    chatReactionReceived: Color(0xFF2C2C2E),
    chatReactionReceivedActive: Color(0xFF315D8F),
    avatarBackground: Color(0xFF4B5563),
    inputSurface: Color(0xFF222327),
    inputBorder: Color(0xFF3A3A3C),
    composerReplyPreviewSurface: Color(0xFF2A2B2F),
    composerReplyPreviewDivider: Color(0xFF3A3A3C),
    composerReplyPreviewTitle: Color(0xFF4087D2),
  );
}

const appBaseTextStyle = TextStyle(
  color: CupertinoColors.label,
  fontFamily: AppFontFamilies.system,
  fontWeight: AppFontWeights.regular,
);

const appCupertinoTheme = CupertinoThemeData(
  textTheme: CupertinoTextThemeData(
    textStyle: appBaseTextStyle,
    actionTextStyle: TextStyle(
      color: CupertinoColors.activeBlue,
      fontFamily: AppFontFamilies.system,
      fontWeight: AppFontWeights.regular,
    ),
    tabLabelTextStyle: appBaseTextStyle,
    navTitleTextStyle: TextStyle(
      color: CupertinoColors.label,
      fontFamily: AppFontFamilies.system,
      fontSize: AppFontSizes.navigationTitle,
      fontWeight: AppFontWeights.semibold,
    ),
    navLargeTitleTextStyle: TextStyle(
      color: CupertinoColors.label,
      fontFamily: AppFontFamilies.system,
      fontWeight: AppFontWeights.bold,
    ),
    navActionTextStyle: TextStyle(
      color: CupertinoColors.activeBlue,
      fontFamily: AppFontFamilies.system,
      fontWeight: AppFontWeights.regular,
    ),
    pickerTextStyle: appBaseTextStyle,
    dateTimePickerTextStyle: appBaseTextStyle,
  ),
);

extension AppThemeContext on BuildContext {
  Brightness get appBrightness => MediaQuery.platformBrightnessOf(this);

  bool get isDarkMode => appBrightness == Brightness.dark;

  AppColorTheme get appColors => AppColorTheme.resolve(
    brightness: appBrightness,
    overrides: AppColorThemeScope.maybeOf(this),
  );
}

TextStyle appTextStyle(
  BuildContext context, {
  Color? color,
  double? fontSize,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
  TextDecoration? decoration,
  Color? decorationColor,
  List<String>? fontFamilyFallback,
}) {
  return CupertinoTheme.of(context).textTheme.textStyle.copyWith(
    color: color ?? context.appColors.textPrimary,
    fontSize: fontSize ?? AppFontSizes.body,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
    decoration: decoration,
    decorationColor: decorationColor,
    fontFamilyFallback: fontFamilyFallback,
  );
}

TextStyle appCaptionTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.caption,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appMetaTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: color ?? context.appColors.textSecondary,
    fontSize: AppFontSizes.meta,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appBodyTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.body,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appBodyLargeTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.bodyLarge,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appSubtitleTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.subtitle,
    fontWeight: fontWeight ?? AppFontWeights.semibold,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appSecondaryTextStyle(
  BuildContext context, {
  double? fontSize,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
}) {
  return appTextStyle(
    context,
    color: context.appColors.textSecondary,
    fontSize: fontSize,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
  );
}

TextStyle appTitleTextStyle(
  BuildContext context, {
  double? fontSize,
  FontWeight? fontWeight,
  Color? color,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: fontSize ?? AppFontSizes.title,
    fontWeight: fontWeight ?? AppFontWeights.semibold,
  );
}

TextStyle appBubbleTextStyle(
  BuildContext context, {
  Color? color,
  double? fontSize,
  FontWeight? fontWeight,
  double? height,
  FontStyle? fontStyle,
  List<String>? fontFamilyFallback,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: fontSize,
    fontWeight: fontWeight,
    height: height,
    fontStyle: fontStyle,
    fontFamilyFallback: fontFamilyFallback,
  );
}

TextStyle appBubbleMetaTextStyle(
  BuildContext context, {
  Color? color,
  double? fontSize,
  FontWeight? fontWeight,
}) {
  return appBubbleTextStyle(
    context,
    color: color ?? context.appColors.textSecondary,
    fontSize: fontSize,
    fontWeight: fontWeight,
  );
}

TextStyle appOnDarkTextStyle(
  BuildContext context, {
  double? fontSize,
  FontWeight? fontWeight,
  Color? color,
}) {
  return appTextStyle(
    context,
    color: color ?? CupertinoColors.white,
    fontSize: fontSize,
    fontWeight: fontWeight,
  );
}

TextStyle appChatEntryTitleTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.chatEntryTitle,
    fontWeight: fontWeight ?? AppFontWeights.semibold,
  );
}

TextStyle appSectionTitleTextStyle(
  BuildContext context, {
  Color? color,
  FontWeight? fontWeight,
}) {
  return appTextStyle(
    context,
    color: color,
    fontSize: AppFontSizes.sectionTitle,
    fontWeight: fontWeight ?? AppFontWeights.semibold,
  );
}
