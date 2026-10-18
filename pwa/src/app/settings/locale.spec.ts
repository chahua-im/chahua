import { detectLocale, isAppLocale } from './locale';

describe('locale detection', () => {
  it('matches exact supported tags first', () => {
    expect(detectLocale(['en', 'zh-CN'])).toBe('en');
    expect(detectLocale(['zh-TW', 'en'])).toBe('zh-TW');
  });

  it('maps language-only and regional tags', () => {
    expect(detectLocale(['en-US'])).toBe('en');
    expect(detectLocale(['zh'])).toBe('zh-CN');
    expect(detectLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(detectLocale(['zh-Hant'])).toBe('zh-TW');
    expect(detectLocale(['zh-HK'])).toBe('zh-TW');
  });

  it('skips unsupported languages before falling back to English', () => {
    expect(detectLocale(['ja-JP', 'zh-CN'])).toBe('zh-CN');
    expect(detectLocale(['ja-JP'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('only accepts supported locale codes from storage', () => {
    expect(isAppLocale('zh-CN')).toBe(true);
    expect(isAppLocale('zh-Hant')).toBe(false);
    expect(isAppLocale(null)).toBe(false);
  });
});
