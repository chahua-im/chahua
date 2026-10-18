export const supportedLocales = ['en', 'zh-CN', 'zh-TW'] as const;
export type AppLocale = (typeof supportedLocales)[number];

export const defaultLocale: AppLocale = 'en';

export const localeLabels: Record<AppLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && supportedLocales.includes(value as AppLocale);
}

/** Match the exact tag first, then the language/script so zh-Hant and zh-HK get Traditional. */
export function detectLocale(languages: readonly string[] = navigator.languages): AppLocale {
  for (const language of languages) {
    if (isAppLocale(language)) return language;
    const [base, ...subtags] = language.toLowerCase().split('-');
    if (base === 'en') return 'en';
    if (base === 'zh') {
      const traditional = subtags.some((tag) => tag === 'hant' || tag === 'tw' || tag === 'hk' || tag === 'mo');
      return traditional ? 'zh-TW' : 'zh-CN';
    }
  }
  return defaultLocale;
}
