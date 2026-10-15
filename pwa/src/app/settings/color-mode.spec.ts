import { ColorMode, applyColorMode, isColorMode, resolveDarkMode } from './color-mode';

describe('color mode', () => {
  afterEach(() => {
    document.documentElement.classList.remove('ion-palette-dark');
    document.documentElement.removeAttribute('style');
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.remove();
  });

  it('resolves the system preference unless a mode is chosen explicitly', () => {
    expect(resolveDarkMode(ColorMode.System, true)).toBe(true);
    expect(resolveDarkMode(ColorMode.System, false)).toBe(false);
    expect(resolveDarkMode(ColorMode.Light, true)).toBe(false);
    expect(resolveDarkMode(ColorMode.Dark, false)).toBe(true);
  });

  it('accepts only known stored modes', () => {
    expect(isColorMode('system')).toBe(true);
    expect(isColorMode('light')).toBe(true);
    expect(isColorMode('dark')).toBe(true);
    expect(isColorMode('sepia')).toBe(false);
    expect(isColorMode(null)).toBe(false);
  });

  it('applies and reverts the resolved scheme on the document', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);

    applyColorMode(true);
    expect(document.documentElement.classList.contains('ion-palette-dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(meta.content).toBe('#0d0d0d');

    applyColorMode(false);
    expect(document.documentElement.classList.contains('ion-palette-dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(meta.content).toBe('#f7f7f7');
  });
});
