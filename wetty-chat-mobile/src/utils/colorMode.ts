export const colorModes = ['system', 'light', 'dark'] as const;
export type ColorMode = (typeof colorModes)[number];

const DARK_MODE_QUERY = '(prefers-color-scheme: dark)';
const LIGHT_THEME_COLOR = '#f7f7f7';
const DARK_THEME_COLOR = '#0d0d0d';

export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === 'string' && colorModes.includes(value as ColorMode);
}

export function getSystemDarkMode(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_MODE_QUERY).matches;
}

export function resolveDarkMode(colorMode: ColorMode, systemDarkMode: boolean): boolean {
  if (colorMode === 'dark') return true;
  if (colorMode === 'light') return false;
  return systemDarkMode;
}

export function applyColorMode(isDarkMode: boolean) {
  const root = document.documentElement;
  root.classList.toggle('ion-palette-dark', isDarkMode);
  root.classList.toggle('ion-palette-light', !isDarkMode);
  root.style.colorScheme = isDarkMode ? 'dark' : 'light';

  const themeColor = isDarkMode ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = themeColor;
  });
}
