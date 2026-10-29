import { existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { assertPortsFree, configure, paths, withLock } from './config.mjs';
import { Processes } from './processes.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const [command, ...args] = process.argv.slice(2);
const commands = ['init', 'dev', 'backend', 'pwa', 'up', 'infra-stop', 'seed', 'reindex', 'compose'];
if (!commands.includes(command)) {
  console.log(
    `Usage: node runspace/dev.mjs <${commands.join('|')}>\n  pwa [--online] [Angular serve options]\n  dev [Angular serve options]\n  compose <Docker Compose arguments>`,
  );
  process.exit(command === '--help' || !command ? 0 : 1);
}
const processes = new Processes();

try {
  if (args.includes('--online') && command !== 'pwa') {
    throw new Error('Online mode is available through: node runspace/dev.mjs pwa --online');
  }
  const online = command === 'pwa' && args.includes('--online');
  const frontendArgs = [];
  let pwaPort;
  if (command === 'dev' || command === 'pwa') {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--port') {
        pwaPort = args[++index];
        if (pwaPort === undefined) throw new Error('--port requires a port number.');
      } else if (arg.startsWith('--port=')) {
        pwaPort = arg.slice('--port='.length);
      } else if (arg !== '--online') {
        frontendArgs.push(arg);
      }
    }
    if (frontendArgs.some((arg) => /^--proxy-config(=|$)/.test(arg))) {
      throw new Error('The proxy target is selected by pwa / pwa --online.');
    }
  }
  const context = await configure(paths(root), {
    initialize: command === 'init' || command === 'up',
    online,
    pwaPort,
  });
  const { shared, sharedEnv, config, api } = context;
  const environment = { ...process.env, ...config };
  const options = { cwd: directory, env: environment };
  const composeArgs = ['compose', '--env-file', sharedEnv, '-f', resolve(directory, 'docker-compose.yml')];
  const compose = (...argv) => processes.run('docker', [...composeArgs, ...argv], options);

  async function waitFor(url, task) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (processes.interrupted) throw new Error('Initialization interrupted.');
      if (task && (task.child.exitCode !== null || task.child.signalCode !== null)) {
        throw new Error('Backend exited before becoming ready; see runspace/backend-init.log.');
      }
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok || (task && response.status === 401)) return;
      } catch {
        /* Wait for the local service to bind its port. */
      }
      await new Promise((accept) => setTimeout(accept, 500));
    }
    throw new Error(`Timed out waiting for ${url}. Inspect service logs.`);
  }

  async function up() {
    await compose('up', '-d', '--wait', 'postgres', 'meilisearch', 'rustfs');
    await Promise.all([waitFor(`${config.MEILI_URL}/health`), waitFor(`${config.S3_ENDPOINT_URL}/health`)]);
    await compose('run', '--rm', '--no-deps', 'storage-init');
  }

  function seed() {
    return processes.run(
      'python3',
      [resolve(directory, 'seed.py'), '--api-url', api, '--state-file', resolve(shared, 'seed-state.json')],
      {
        ...options,
        env: { ...environment, RUNSPACE_SHARED_ENV: sharedEnv },
      },
    );
  }

  function requireBacon() {
    try {
      execFileSync('bacon', ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error('Install the backend watcher first: cargo install --locked bacon');
    }
  }

  function backend() {
    // Resolve watch paths locally; the Cargo job still fetches build dependencies when needed.
    return processes.start('bacon', ['--headless', '--offline', 'dev'], {
      ...options,
      cwd: resolve(root, 'backend'),
      label: 'backend',
    });
  }

  async function preparePwa() {
    if (!existsSync(resolve(root, 'pwa/node_modules/@angular/cli'))) {
      await processes.run('npm', ['ci'], {
        ...options,
        cwd: resolve(root, 'pwa'),
      });
    }
  }

  function pwa() {
    const port = online ? config.ONLINE_PWA_PORT : config.PWA_PORT;
    const extra = frontendArgs;
    const presetFile = resolve(root, 'pwa/.env.local');
    const preset = existsSync(presetFile) ? parseEnv(readFileSync(presetFile, 'utf8')) : {};
    let ssl = online;
    for (let index = 0; index < extra.length; index++) {
      if (extra[index] === '--ssl') ssl = extra[index + 1] !== 'false';
      if (extra[index].startsWith('--ssl=')) ssl = extra[index] === '--ssl=true';
    }
    console.log(`PWA: ${ssl ? 'https' : 'http'}://localhost:${port} → ${online ? 'https://chahui.app/_api' : api}`);
    return processes.start(
      process.execPath,
      [
        resolve(root, 'pwa/scripts/dev.mjs'),
        '--proxy-config',
        'proxy.conf.dev.mjs',
        '--host',
        config.PWA_HOST ?? '127.0.0.1',
        '--port',
        port,
        ...(online ? ['--ssl'] : []),
        ...extra,
      ],
      {
        ...options,
        cwd: resolve(root, 'pwa'),
        label: 'pwa',
        env: {
          ...environment,
          API_PROXY_TARGET: online ? 'https://chahui.app/_api' : api,
          STORAGE_PROXY_TARGET: online ? '' : new URL(config.S3_ENDPOINT_URL).origin,
          CHAHUA_DEV_TOKEN: preset.CHAHUA_DEV_TOKEN ?? '',
        },
      },
    );
  }

  switch (command) {
    case 'init':
      await withLock(resolve(shared, 'init.lock'), async () => {
        await assertPortsFree(config.API_PORT, config.METRICS_PORT);
        await up();
        await processes.run('cargo', ['build', '--locked', '--manifest-path', '../backend/Cargo.toml'], options);
        const log = openSync(resolve(directory, 'backend-init.log'), 'w', 0o600);
        const task = processes.start('cargo', ['run', '--locked', '--manifest-path', '../backend/Cargo.toml'], {
          ...options,
          stdio: ['ignore', log, log],
        });
        try {
          await waitFor(`${api}/users/me`, task);
          await seed();
        } finally {
          processes.stop(task.child);
          await task.done;
          closeSync(log);
        }
      });
      console.log('Initialized shared services and this worktree. Run: node runspace/dev.mjs dev');
      break;
    case 'dev': {
      requireBacon();
      await assertPortsFree(config.API_PORT, config.METRICS_PORT, config.PWA_PORT);
      await up();
      await preparePwa();
      await processes.foreground([backend(), pwa()]);
      break;
    }
    case 'backend':
      requireBacon();
      await assertPortsFree(config.API_PORT, config.METRICS_PORT);
      await processes.foreground([backend()]);
      break;
    case 'pwa':
      await assertPortsFree(online ? config.ONLINE_PWA_PORT : config.PWA_PORT);
      await preparePwa();
      await processes.foreground([pwa()]);
      break;
    case 'up':
      await up();
      break;
    case 'infra-stop':
      await compose('stop');
      break;
    case 'compose':
      await compose(...args);
      break;
    case 'seed':
      await withLock(resolve(shared, 'init.lock'), seed);
      break;
    case 'reindex':
      await processes.run(
        'cargo',
        ['run', '--locked', '--manifest-path', '../backend/Cargo.toml', '--', 'message-search-reindex'],
        options,
      );
      break;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = processes.interrupted ? 130 : 1;
} finally {
  processes.dispose();
}
