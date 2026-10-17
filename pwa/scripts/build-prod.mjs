import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const workspace = new URL('../', import.meta.url);
const { status, error } = spawnSync(
  process.execPath,
  [
    new URL('node_modules/@angular/cli/bin/ng.js', workspace).pathname,
    'build',
    '--configuration=production,prod',
    ...process.argv.slice(2),
  ],
  { cwd: workspace, stdio: 'inherit' },
);
if (error) throw error;
if (status !== 0) process.exit(status ?? 1);

const angular = JSON.parse(await readFile(new URL('angular.json', workspace), 'utf8'));
const { outputPath, deployUrl } = angular.projects.app.architect.build.configurations.prod;
const manifestFile = new URL(`${outputPath}/browser/ngsw.json`, workspace);
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
// deployUrl relocates bundles, but Angular generates its worker manifest relative to baseHref.
// Keep public assets and the worker on the document origin; retain bundle integrity hashes.
const assetUrl = (url) =>
  url !== '/serviceWorker.js' && /^\/(?:[^/]+\.(?:js|css)|media\/.+)$/.test(url)
    ? new URL(url.slice(1), deployUrl).href
    : url;
for (const group of manifest.assetGroups) group.urls = group.urls.map(assetUrl);
manifest.hashTable = Object.fromEntries(
  Object.entries(manifest.hashTable).map(([url, hash]) => [assetUrl(url), hash]),
);
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
