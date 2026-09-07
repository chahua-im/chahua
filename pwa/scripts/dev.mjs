import { fileURLToPath } from 'node:url';

const cli = new URL('../node_modules/@angular/cli/bin/ng.js', import.meta.url);
process.argv = [
  process.execPath,
  fileURLToPath(cli),
  'serve',
  `--define=CHAHUA_DEV_TOKEN=${JSON.stringify(process.env.CHAHUA_DEV_TOKEN || '')}`,
  ...process.argv.slice(2),
];
await import(cli.href);
