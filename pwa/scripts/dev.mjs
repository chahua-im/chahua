import { fileURLToPath } from 'node:url';

// Dev-session tooling (per-tab UID switching) must stay off against the real
// production backend, where the endpoint is disabled and a failed switch would
// clear a real login. npm start proxies to production via proxy.conf.json;
// npm run dev defaults to a local backend but API_PROXY_TARGET may point
// anywhere, including a collaborator's remote development backend.
const userArgs = process.argv.slice(2);
const proxyIndex = userArgs.indexOf('--proxy-config');
const usingDevProxy = proxyIndex >= 0 && (userArgs[proxyIndex + 1] ?? '').endsWith('proxy.conf.dev.mjs');
const target = usingDevProxy ? (process.env.API_PROXY_TARGET ?? 'http://localhost:3000') : 'https://chahui.app';
const productionBackend = /^https?:\/\/([^/]+\.)?chahui\.app(\/|$)/.test(target);
const cli = new URL('../node_modules/@angular/cli/bin/ng.js', import.meta.url);
process.argv = [
  process.execPath,
  fileURLToPath(cli),
  'serve',
  `--define=CHAHUA_DEV_TOKEN=${JSON.stringify(process.env.CHAHUA_DEV_TOKEN || '')}`,
  `--define=CHAHUA_DEV_BACKEND=${!productionBackend}`,
  ...userArgs,
];
await import(cli.href);
