import { readFile, writeFile } from 'node:fs/promises';

// Startup recovery must work without JavaScript bundles or translation requests.
// Keep its embedded copy generated from the same catalogs as the application.
const catalogs = {};
for (const locale of ['en', 'zh-CN', 'zh-TW']) {
  const { app } = JSON.parse(await readFile(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8'));
  const { reload, boot, bootSlow, bootFailed } = app.entry;
  catalogs[locale] = { reload, boot, bootSlow, bootFailed };
}
const file = new URL('../src/index.html', import.meta.url);
const html = await readFile(file, 'utf8');
const json = JSON.stringify(catalogs).replaceAll('<', '\\u003c');
await writeFile(
  file,
  html.replace(/(<script id="startup-copy" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${json}$2`),
);
