import { createECDH, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const envFile = resolve(directory, '.env');
const command = process.argv[2];
const commands = ['init', 'up', 'stop', 'backend', 'pwa', 'seed'];
if (!commands.includes(command)) {
  console.error(`Usage: node runspace/dev.mjs <${commands.join('|')}>`);
  process.exit(1);
}

function initializeConfig() {
  if (existsSync(envFile)) return;
  const vapid = createECDH('prime256v1');
  vapid.generateKeys();
  const id = createHash('sha256').update(root).digest('hex').slice(0, 8);
  const config = {
    COMPOSE_PROJECT_NAME: `chahua-${id}`,
    POSTGRES_PORT: '15432',
    MEILI_PORT: '17700',
    S3_PORT: '19000',
    S3_CONSOLE_PORT: '19001',
    PWA_PORT: '14300',
    DATABASE_URL: 'postgres://wetty_chat:local-chat-password@127.0.0.1:15432/wetty_chat',
    APP_ADDR: '127.0.0.1:13000',
    METRICS_ADDR: '127.0.0.1:13001',
    JWT_SIGNING_KEY_BASE64: randomBytes(32).toString('base64'),
    SERVICE_TOKEN_HASH_KEY_BASE64: randomBytes(32).toString('base64'),
    VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:dev@example.test',
    S3_BUCKET_NAME: 'chahua-local',
    AWS_REGION: 'us-west-2',
    AWS_ACCESS_KEY_ID: 'rustfsadmin',
    AWS_SECRET_ACCESS_KEY: 'rustfsadmin',
    AWS_EC2_METADATA_DISABLED: 'true',
    S3_ENDPOINT_URL: 'http://127.0.0.1:19000',
    S3_BASE_URL: 'http://127.0.0.1:19000/chahua-local',
    CORS_ALLOWED_ORIGINS: 'http://localhost:14300,http://127.0.0.1:14300',
    MESSAGE_SEARCH_ENABLED: 'true',
    MEILI_URL: 'http://127.0.0.1:17700',
    MEILI_MASTER_KEY: randomBytes(24).toString('hex'),
    MESSAGE_SEARCH_INDEX: 'messages_v1',
    ENABLE_DEBUG_AUTH: 'true',
    BACKEND_LOG_FORMAT: 'pretty',
    RUST_LOG: 'info',
  };
  writeFileSync(envFile, Object.entries(config).map(([key, value]) => `${key}=${value}\n`).join(''), {
    mode: 0o600, flag: 'wx',
  });
  console.log('Created runspace/.env with checkout-local configuration and development keys.');
}

if (command === 'init') initializeConfig();
if (!existsSync(envFile)) throw new Error('Run node runspace/dev.mjs init first.');
const config = parseEnv(readFileSync(envFile, 'utf8'));
const environment = { ...process.env, ...config };
const api = `http://${config.APP_ADDR}`;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: directory, env: environment, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${result.status}).`);
  return result.stdout;
}

function compose(...args) {
  return run('docker', ['compose', '--env-file', envFile, '-f', resolve(directory, 'docker-compose.yml'), ...args]);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('Backend exited before becoming ready; see runspace/backend-init.log.');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // /users/me without credentials returning 401 also proves the router is ready.
      if (response.ok || (child && response.status === 401)) return;
    } catch { /* Services can take time to bind their ports. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}. Inspect docker compose logs or runspace/backend-init.log.`);
}

async function up() {
  compose('up', '-d', '--wait', 'postgres', 'meilisearch', 'rustfs');
  await Promise.all([
    waitFor(`${config.MEILI_URL}/health`),
    waitFor(`${config.S3_ENDPOINT_URL}/health`),
  ]);
  compose('run', '--rm', '--no-deps', 'storage-init');
}

function buildBackend() {
  const manifest = resolve(root, 'backend/Cargo.toml');
  run('cargo', ['build', '--locked', '--manifest-path', manifest]);
  const metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest], {
    stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
  }));
  return resolve(metadata.target_directory, 'debug/wetty-chat-backend');
}

function launch(program, args = [], options = {}) {
  const child = spawn(program, args, { cwd: directory, env: environment, stdio: 'inherit', ...options });
  child.on('error', (error) => console.error(error.message));
  return child;
}

async function foreground(child) {
  const signals = ['SIGINT', 'SIGTERM'];
  const forward = (signal) => child.kill(signal);
  for (const signal of signals) process.on(signal, forward);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  for (const signal of signals) process.off(signal, forward);
  process.exitCode = code;
}

function seed() {
  run('python3', [resolve(directory, 'seed.py'), '--api-url', api]);
}

async function assertPortFree(address) {
  const separator = address.lastIndexOf(':');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error(`${address} is occupied. Stop this checkout's backend before initialization.`)));
    server.listen(Number(address.slice(separator + 1)), address.slice(0, separator), resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

try {
  switch (command) {
    case 'init': {
      await assertPortFree(config.APP_ADDR);
      await assertPortFree(config.METRICS_ADDR);
      await up();
      const binary = buildBackend();
      const log = openSync(resolve(directory, 'backend-init.log'), 'w', 0o600);
      const child = launch(binary, [], { stdio: ['ignore', log, log] });
      const stop = () => child.kill('SIGTERM');
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      try {
        await waitFor(`${api}/users/me`, child);
        seed();
      } finally {
        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((resolve) => child.once('exit', resolve));
        }
        closeSync(log);
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      console.log(`\nInitialized. Dependencies remain running; temporary backend stopped.\nBackend: node runspace/dev.mjs backend\nPWA:     node runspace/dev.mjs pwa\nOpen:    http://localhost:${config.PWA_PORT}`);
      break;
    }
    case 'up':
      await up();
      break;
    case 'stop':
      compose('stop');
      break;
    case 'backend':
      await foreground(launch(buildBackend()));
      break;
    case 'pwa':
      if (!existsSync(resolve(root, 'pwa/node_modules/@angular/cli'))) {
        run('npm', ['ci'], { cwd: resolve(root, 'pwa') });
      }
      await foreground(launch(process.execPath, [
        resolve(root, 'pwa/scripts/dev.mjs'), '--proxy-config', 'proxy.conf.dev.mjs',
        '--host', '127.0.0.1', '--port', config.PWA_PORT,
      ], {
        cwd: resolve(root, 'pwa'),
        env: { ...environment, API_PROXY_TARGET: api, CHAHUA_DEV_TOKEN: '' },
      }));
      break;
    case 'seed':
      seed();
      break;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
