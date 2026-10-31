import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const gitFiles = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [
  ...new Set([
    ...gitFiles('diff', '--name-only', '--relative', '--diff-filter=d', '-z', '--', '.'),
    ...gitFiles('diff', '--cached', '--name-only', '--relative', '--diff-filter=d', '-z', '--', '.'),
    ...gitFiles('ls-files', '--others', '--exclude-standard', '-z', '--', '.'),
  ]),
].filter((file) => existsSync(resolve(cwd, file)));

if (files.length) {
  const prettier = fileURLToPath(new URL('../node_modules/prettier/bin/prettier.cjs', import.meta.url));
  execFileSync(process.execPath, [prettier, '--write', '--ignore-unknown', '--', ...files], {
    cwd,
    stdio: 'inherit',
  });
} else {
  console.log('No changed files under pwa/.');
}
