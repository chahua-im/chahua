import { createECDH, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const appPortKeys = ['API_PORT', 'METRICS_PORT', 'PWA_PORT', 'ONLINE_PWA_PORT'];
const sharedPortKeys = ['POSTGRES_PORT', 'MEILI_PORT', 'S3_PORT', 'S3_CONSOLE_PORT'];
const validPort = (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;

function validatePorts(...groups) {
  const used = new Map();
  for (const [file, config, keys] of groups) {
    for (const key of keys) {
      const value = config[key];
      if (!validPort(value)) throw new Error(`${file}: ${key} must be an integer between 1 and 65535.`);
      const port = Number(value);
      if (used.has(port)) throw new Error(`${file}: ${key} conflicts with ${used.get(port)} on port ${port}.`);
      used.set(port, `${key} (${file})`);
    }
  }
}

const readEnv = (file) => (existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {});
const writeEnv = (file, config) =>
  writeFileSync(
    file,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
    { mode: 0o600, flag: 'wx' },
  );

export function paths(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const shared = resolve(common, 'runspace');
  return {
    root,
    shared,
    sharedEnv: resolve(shared, '.env'),
    localEnv: resolve(root, 'runspace/.env'),
    git,
  };
}

export async function withLock(file, action) {
  try {
    mkdirSync(file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      `Another runspace command holds ${file}. If it was forcibly killed, remove that lock directory and retry.`,
    );
  }
  try {
    return await action();
  } finally {
    rmSync(file, { recursive: true });
  }
}

export async function portAvailable(port) {
  const server = createServer();
  return new Promise((accept, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') accept(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => accept(true)));
  });
}

export async function assertPortsFree(...ports) {
  for (const port of ports) {
    if (!(await portAvailable(Number(port))))
      throw new Error(`Port ${port} is occupied. Stop the process using this worktree's port before retrying.`);
  }
}

function sharedDefaults(shared) {
  const vapid = createECDH('prime256v1');
  vapid.generateKeys();
  return {
    COMPOSE_PROJECT_NAME: `chahua-${createHash('sha256').update(shared).digest('hex').slice(0, 8)}`,
    POSTGRES_PORT: '15432',
    MEILI_PORT: '17700',
    S3_PORT: '19000',
    S3_CONSOLE_PORT: '19001',
    DATABASE_URL: 'postgres://wetty_chat:local-chat-password@127.0.0.1:15432/wetty_chat',
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
    MESSAGE_SEARCH_ENABLED: 'true',
    MEILI_URL: 'http://127.0.0.1:17700',
    MEILI_MASTER_KEY: randomBytes(24).toString('hex'),
    MESSAGE_SEARCH_INDEX: 'messages_v1',
    ENABLE_DEBUG_AUTH: 'true',
    BACKEND_LOG_FORMAT: 'pretty',
    RUST_LOG: 'info',
  };
}

export async function configure(locations, { initialize = false, online = false, pwaPort } = {}) {
  if (pwaPort !== undefined && !validPort(pwaPort)) {
    throw new Error('--port must be an integer between 1 and 65535.');
  }
  const { root, shared, sharedEnv, localEnv, git } = locations;
  mkdirSync(shared, { recursive: true });
  return withLock(resolve(shared, 'config.lock'), async () => {
    if (initialize && !existsSync(sharedEnv)) {
      writeEnv(sharedEnv, sharedDefaults(shared));
      console.log(`Created shared configuration: ${sharedEnv}`);
    }
    if (!online && !existsSync(sharedEnv)) throw new Error('Run node runspace/dev.mjs init first.');
    const sharedConfig = readEnv(sharedEnv);
    const sharedPorts = [sharedEnv, sharedConfig, existsSync(sharedEnv) ? sharedPortKeys : []];
    validatePorts(sharedPorts);
    let local = readEnv(localEnv);
    if (local.DATABASE_URL)
      throw new Error(
        'Legacy runspace/.env found. Preserve it for data migration, then move it aside before using the shared runspace.',
      );
    if (!existsSync(localEnv)) {
      const reserved = new Set(
        Object.entries(sharedConfig)
          .filter(([key]) => key.endsWith('_PORT'))
          .map(([, value]) => Number(value)),
      );
      const worktrees = git('worktree', 'list', '--porcelain', '-z')
        .split('\0')
        .filter((field) => field.startsWith('worktree '))
        .map((field) => field.slice(9));
      for (const worktree of worktrees) {
        const config = readEnv(resolve(worktree, 'runspace/.env'));
        for (const [key, value] of Object.entries(config)) {
          if (key.endsWith('_PORT')) reserved.add(Number(value));
          if (key.endsWith('_ADDR')) reserved.add(Number(value.split(':').at(-1)));
        }
      }
      async function allocate(start) {
        for (let port = start; port < 65536; port++) {
          if (!reserved.has(port) && (await portAvailable(port))) {
            reserved.add(port);
            return String(port);
          }
        }
        throw new Error('No free development ports.');
      }
      local = {
        API_PORT: await allocate(13000),
        METRICS_PORT: await allocate(13001),
        PWA_PORT: await allocate(14300),
        ONLINE_PWA_PORT: await allocate(14301),
      };
      writeEnv(localEnv, local);
    }
    validatePorts(sharedPorts, [localEnv, local, appPortKeys]);
    if (pwaPort !== undefined) {
      const otherPorts = [
        local.API_PORT,
        local.METRICS_PORT,
        ...Object.entries(sharedConfig)
          .filter(([key]) => key.endsWith('_PORT'))
          .map(([, value]) => value),
      ];
      if (otherPorts.some((port) => Number(port) === Number(pwaPort))) {
        throw new Error('--port conflicts with a backend or shared infrastructure port.');
      }
      local = {
        ...local,
        [online ? 'ONLINE_PWA_PORT' : 'PWA_PORT']: String(Number(pwaPort)),
      };
    }
    const config = {
      ...sharedConfig,
      ...local,
      APP_ADDR: `127.0.0.1:${local.API_PORT}`,
      METRICS_ADDR: `127.0.0.1:${local.METRICS_PORT}`,
      CORS_ALLOWED_ORIGINS: `http://localhost:${local.PWA_PORT},http://127.0.0.1:${local.PWA_PORT},https://localhost:${local.PWA_PORT},https://127.0.0.1:${local.PWA_PORT}`,
    };
    return {
      ...locations,
      config,
      api: `http://${config.APP_ADDR}`,
      cwd: resolve(root, 'runspace'),
    };
  });
}
