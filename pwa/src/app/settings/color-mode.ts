export enum ColorMode {
  System = 'system',
  Light = 'light',
  Dark = 'dark',
}

export function isColorMode(value: unknown): value is ColorMode {
  return value === ColorMode.System || value === ColorMode.Light || value === ColorMode.Dark;
}

export function resolveDarkMode(colorMode: ColorMode, systemDark: boolean): boolean {
  return colorMode === ColorMode.System ? systemDark : colorMode === ColorMode.Dark;
}

const LIGHT_THEME_COLOR = '#f7f7f7';
const DARK_THEME_COLOR = '#0d0d0d';

/** Ionic keys its dark palette off the root class, so the theme is applied to the document element. */
export function applyColorMode(dark: boolean) {
  const root = document.documentElement;
  root.classList.toggle('ion-palette-dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
    meta.content = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
}
