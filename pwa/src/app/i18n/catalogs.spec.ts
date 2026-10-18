import en from '../../i18n/en.json';
import zhCN from '../../i18n/zh-CN.json';
import zhTW from '../../i18n/zh-TW.json';

interface Catalog {
  [key: string]: string | Catalog;
}

function flatten(catalog: Catalog, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') entries.set(path, value);
    else for (const [childKey, childValue] of flatten(value, path)) entries.set(childKey, childValue);
  }
  return entries;
}

function placeholders(value: string) {
  return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
}

const catalogs = { en, 'zh-CN': zhCN, 'zh-TW': zhTW };

describe('i18n catalogs', () => {
  const reference = flatten(en as Catalog);

  it('uses the same keys in every locale', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect([...flatten(catalog as Catalog).keys()].sort(), locale).toEqual([...reference.keys()].sort());
    }
  });

  it('keeps interpolation placeholders in sync', () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of flatten(catalog as Catalog)) {
        expect(placeholders(value), `${locale}:${key}`).toEqual(placeholders(reference.get(key)!));
      }
    }
  });

  it('keeps empty fragments consistent across locales', () => {
    // Word-order fragments may be empty everywhere, but never in one locale only.
    const flattened = Object.entries(catalogs).map(([, catalog]) => flatten(catalog as Catalog));
    for (const [key] of flattened[0]) {
      const empties = flattened.filter((catalog) => catalog.get(key)!.trim() === '').length;
      expect(empties === 0 || empties === flattened.length, key).toBe(true);
    }
  });
});
