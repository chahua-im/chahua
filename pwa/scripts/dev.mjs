import { fileURLToPath } from 'node:url';

// Dev-session tooling (per-tab UID switching) must stay off against the real
// production backend, where the endpoint is disabled and a failed switch would
// clear a real login. runspace selects the current worktree's backend or the
// explicit --online target for both this flag and the HTTP/WebSocket proxy.
const userArgs = process.argv.slice(2);
const target = process.env.API_PROXY_TARGET;
if (!target) throw new Error('Start the PWA through node runspace/dev.mjs pwa or npm start.');
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
