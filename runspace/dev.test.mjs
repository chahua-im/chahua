import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { configure, paths, portAvailable } from './config.mjs';
import { Processes } from './processes.mjs';

const source = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const parent = mkdtempSync(resolve(tmpdir(), 'chahua-dev-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = resolve(parent, 'main checkout');
  mkdirSync(root);
  mkdirSync(resolve(root, 'runspace'));
  for (const file of ['dev.mjs', 'config.mjs', 'processes.mjs', 'docker-compose.yml', 'seed.py']) {
    cpSync(resolve(source, file), resolve(root, 'runspace', file));
  }
  writeFileSync(resolve(root, '.gitignore'), '.env\nnode_modules/\n*.log\n');
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      stdio: 'pipe',
    }).toString();
  git('init');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  return { parent, root, git };
}
function setEnv(file, values) {
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}
async function waitUntil(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error('Timed out waiting for test process.');
}

test('worktrees share infra and credentials but keep distinct, persistent app ports', async (t) => {
  const { root, parent, git } = fixture(t);
  const other = resolve(parent, 'other checkout');
  git('worktree', 'add', '--detach', other);
  const first = await configure(paths(root), { initialize: true });
  const second = await configure(paths(other));
  assert.equal(first.shared, second.shared);
  for (const key of ['DATABASE_URL', 'COMPOSE_PROJECT_NAME', 'JWT_SIGNING_KEY_BASE64', 'S3_ENDPOINT_URL']) {
    assert.equal(first.config[key], second.config[key]);
  }
  const keys = ['API_PORT', 'METRICS_PORT', 'PWA_PORT', 'ONLINE_PWA_PORT'];
  assert.equal(new Set(keys.flatMap((key) => [first.config[key], second.config[key]])).size, 8);
  assert.deepEqual((await configure(paths(other))).config, second.config);
  assert.equal(second.api, `http://127.0.0.1:${second.config.API_PORT}`);
  assert.match(second.config.CORS_ALLOWED_ORIGINS, new RegExp(`:${second.config.PWA_PORT}`));
  assert.equal(second.config.S3_BASE_URL, '/_storage/chahua-local');
  assert.equal(second.config.S3_UPLOAD_PROXY_PATH, '/_storage');
  execFileSync('docker', [
    'compose',
    '--env-file',
    first.sharedEnv,
    '-f',
    resolve(root, 'runspace/docker-compose.yml'),
    'config',
    '--quiet',
  ]);
});

test('online frontend config does not require shared infrastructure initialization', async (t) => {
  const { root } = fixture(t);
  const online = await configure(paths(root), {
    online: true,
    pwaPort: '24443',
  });
  assert.equal(online.config.ONLINE_PWA_PORT, '24443');
  assert.ok(readFileSync(online.localEnv, 'utf8').includes('API_PORT='));
  assert.equal(online.config.DATABASE_URL, undefined);
  assert.equal(online.config.S3_UPLOAD_PROXY_PATH, undefined);
  await assert.rejects(configure(paths(root)), /init first/);
  await assert.rejects(configure(paths(root), { online: true, pwaPort: '65536' }), /between 1 and 65535/);
});

test('saved ports reject missing fields, invalid numbers, and app/shared service collisions', async (t) => {
  const { root } = fixture(t);
  const context = await configure(paths(root), { initialize: true });
  const keys = ['API_PORT', 'METRICS_PORT', 'PWA_PORT', 'ONLINE_PWA_PORT'];
  const local = Object.fromEntries(keys.map((key) => [key, context.config[key]]));
  const cases = [
    ...keys.map((key) => [key, undefined, /between 1 and 65535/]),
    ['API_PORT', '99999', /between 1 and 65535/],
    ['METRICS_PORT', '0', /between 1 and 65535/],
    ['PWA_PORT', 'abc', /between 1 and 65535/],
    ['ONLINE_PWA_PORT', '14301.5', /between 1 and 65535/],
    ['PWA_PORT', local.API_PORT, /conflicts with API_PORT/],
    ['METRICS_PORT', local.API_PORT, /conflicts with API_PORT/],
    ['ONLINE_PWA_PORT', local.PWA_PORT, /conflicts with PWA_PORT/],
    ['API_PORT', context.config.POSTGRES_PORT, /conflicts with POSTGRES_PORT/],
  ];
  for (const [key, value, message] of cases) {
    const edited = { ...local, [key]: value };
    if (value === undefined) delete edited[key];
    setEnv(context.localEnv, edited);
    await assert.rejects(configure(paths(root)), (error) => {
      assert.ok(error.message.includes(context.localEnv));
      assert.ok(error.message.includes(key));
      assert.match(error.message, message);
      return true;
    });
  }
  setEnv(context.localEnv, local);
  const sharedText = readFileSync(context.sharedEnv, 'utf8');
  writeFileSync(context.sharedEnv, sharedText.replace(/^S3_PORT=.*$/m, 'S3_PORT=invalid'));
  await assert.rejects(configure(paths(root)), (error) => {
    assert.ok(error.message.includes(context.sharedEnv));
    assert.match(error.message, /S3_PORT must be an integer/);
    return true;
  });
  writeFileSync(context.sharedEnv, sharedText);
  assert.deepEqual((await configure(paths(root))).config, context.config);
});

test('process shutdown also terminates a descendant that ignores SIGTERM', async (t) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((accept) => probe.close(accept));
  const manager = new Processes();
  t.after(() => manager.dispose());
  const childCode = `require('node:net').createServer().listen(${port}, '127.0.0.1'); process.on('SIGTERM', () => {});`;
  const task = manager.start(
    process.execPath,
    [
      '-e',
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`,
    ],
    { stdio: 'ignore' },
  );
  await waitUntil(async () => !(await portAvailable(port)));
  manager.stop(task.child);
  await task.done;
  await waitUntil(() => portAvailable(port));
});

test('dev uses shared Compose, isolates targets, and cleans up on Ctrl+C; online stays explicit', async (t) => {
  const { root, parent } = fixture(t);
  const context = await configure(paths(root), { initialize: true });
  const health = httpServer((_, response) => response.end('ok'));
  health.listen(0, '127.0.0.1');
  await once(health, 'listening');
  t.after(() => health.close());
  const endpoint = `http://127.0.0.1:${health.address().port}`;
  const shared = {
    ...context.config,
    MEILI_URL: endpoint,
    S3_ENDPOINT_URL: endpoint,
  };
  for (const key of [
    'API_PORT',
    'METRICS_PORT',
    'PWA_PORT',
    'ONLINE_PWA_PORT',
    'APP_ADDR',
    'METRICS_ADDR',
    'CORS_ALLOWED_ORIGINS',
  ])
    delete shared[key];
  setEnv(context.sharedEnv, shared);
  const bin = resolve(parent, 'bin');
  mkdirSync(bin);
  const composeLog = resolve(parent, 'compose.jsonl');
  writeFileSync(
    resolve(bin, 'docker'),
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(composeLog)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(bin, 'bacon'),
    `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.exit(0);\nconst net=require('node:net'); for (const key of ['APP_ADDR','METRICS_ADDR']) net.createServer().listen(Number(process.env[key].split(':').pop()),'127.0.0.1');\nconsole.log('CORS '+process.env.CORS_ALLOWED_ORIGINS);\nconsole.log('WATCHER_READY');`,
    { mode: 0o755 },
  );
  mkdirSync(resolve(root, 'backend'));
  mkdirSync(resolve(root, 'pwa/scripts'), { recursive: true });
  mkdirSync(resolve(root, 'pwa/node_modules/@angular/cli/bin'), {
    recursive: true,
  });
  writeFileSync(resolve(root, 'pwa/package.json'), '{"type":"module"}');
  cpSync(resolve(source, '../pwa/scripts/dev.mjs'), resolve(root, 'pwa/scripts/dev.mjs'));
  writeFileSync(resolve(root, 'pwa/node_modules/@angular/cli/package.json'), '{"type":"module"}');
  writeFileSync(
    resolve(root, 'pwa/node_modules/@angular/cli/bin/ng.js'),
    `import net from 'node:net'; console.log('CLI_ARGS '+JSON.stringify(process.argv)); console.log('TARGET '+process.env.API_PROXY_TARGET); console.log('STORAGE '+process.env.STORAGE_PROXY_TARGET); net.createServer().listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`,
  );
  const run = (args) => {
    const child = spawn(process.execPath, [resolve(root, 'runspace/dev.mjs'), ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        API_PROXY_TARGET: 'https://unexpected.example',
        STORAGE_PROXY_TARGET: 'https://unexpected.example',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
    return { child, output: () => output };
  };
  writeFileSync(context.localEnv, readFileSync(context.localEnv, 'utf8') + 'PWA_HOST=0.0.0.0\n');
  const savedEnv = readFileSync(context.localEnv, 'utf8');
  const defaultPortBlocker = createServer();
  defaultPortBlocker.listen(Number(context.config.PWA_PORT), '127.0.0.1');
  await once(defaultPortBlocker, 'listening');
  t.after(() => defaultPortBlocker.close());
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const overridePort = String(probe.address().port);
  await new Promise((accept) => probe.close(accept));
  const local = run(['dev', '--port', overridePort, '--ssl', '--ssl-cert', 'dev.pem', '--ssl-key', 'dev-key.pem']);
  await waitUntil(() => local.output().includes('WATCHER_READY') && local.output().includes('CLI_ARGS'));
  assert.match(local.output(), new RegExp(`TARGET http://127.0.0.1:${context.config.API_PORT}`));
  assert.ok(local.output().includes(`STORAGE ${endpoint}\n`));
  assert.match(local.output(), /CHAHUA_DEV_BACKEND=true/);
  assert.match(local.output(), /"--host","0.0.0.0"/);
  assert.match(local.output(), new RegExp(`PWA: https://localhost:${overridePort}`));
  assert.match(local.output(), new RegExp(`CORS .*https://localhost:${overridePort}`));
  assert.match(local.output(), /"--ssl-cert","dev.pem","--ssl-key","dev-key.pem"/);
  assert.equal(await portAvailable(Number(overridePort)), false);
  assert.equal(readFileSync(context.localEnv, 'utf8'), savedEnv);
  const exited = once(local.child, 'exit');
  local.child.kill('SIGINT');
  await exited;
  for (const key of ['API_PORT', 'METRICS_PORT']) assert.equal(await portAvailable(Number(context.config[key])), true);
  assert.equal(await portAvailable(Number(overridePort)), true);
  const calls = readFileSync(composeLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every((call) => call[call.indexOf('--env-file') + 1] === context.sharedEnv));
  assert.ok(!calls.some((call) => call.includes('stop') || call.includes('down')));
  const online = run(['pwa', '--online', `--port=${overridePort}`, '--host', '127.0.0.1']);
  await waitUntil(() => online.output().includes('CLI_ARGS'));
  assert.match(online.output(), /TARGET https:\/\/chahui.app\/_api/);
  assert.match(online.output(), /CHAHUA_DEV_BACKEND=false/);
  assert.match(online.output(), /"--host","127.0.0.1"/);
  assert.ok(online.output().includes('STORAGE \n'));
  assert.match(online.output(), new RegExp(`localhost:${overridePort}`));
  const onlineExited = once(online.child, 'exit');
  online.child.kill('SIGINT');
  await onlineExited;
  assert.equal(readFileSync(context.localEnv, 'utf8'), savedEnv);
  const occupied = run(['pwa', '--port', String(health.address().port)]);
  assert.equal((await once(occupied.child, 'exit'))[0], 1);
  assert.match(occupied.output(), /occupied/);
  for (const args of [['--port'], ['--port=0'], ['--port=abc'], ['--port', context.config.API_PORT]]) {
    const invalid = run(['pwa', ...args]);
    assert.equal((await once(invalid.child, 'exit'))[0], 1);
    assert.match(invalid.output(), /--port/);
    assert.ok(!invalid.output().includes('CLI_ARGS'));
  }
  assert.equal(readFileSync(composeLog, 'utf8').trim().split('\n').length, calls.length);
});

test(
  'real bacon restarts on source/migrations/lockfile changes and recovers after compilation errors',
  {
    skip: !process.env.RUNSPACE_TEST_BACON,
    timeout: 60000,
  },
  async (t) => {
    const { root } = fixture(t);
    const context = await configure(paths(root), { initialize: true });
    const backend = resolve(root, 'backend');
    mkdirSync(resolve(backend, 'src'), { recursive: true });
    mkdirSync(resolve(backend, 'migrations'));
    cpSync(resolve(source, '../backend/bacon.toml'), resolve(backend, 'bacon.toml'));
    writeFileSync(
      resolve(backend, 'Cargo.toml'),
      '[package]\nname="runspace-watcher-test"\nversion="0.1.0"\nedition="2021"\n',
    );
    writeFileSync(resolve(backend, 'migrations/version.txt'), 'migration-one');
    writeFileSync(resolve(backend, 'build.rs'), 'fn main() { println!("cargo:rerun-if-changed=migrations"); }');
    const main = `use std::{io::{Read, Write}, net::TcpListener};
const VERSION: &str = "source-one";
fn main() {
  let listener = TcpListener::bind(std::env::var("APP_ADDR").unwrap()).unwrap();
  let _metrics = TcpListener::bind(std::env::var("METRICS_ADDR").unwrap()).unwrap();
  for stream in listener.incoming() {
    let mut stream = stream.unwrap(); let mut buf = [0; 1024]; let _ = stream.read(&mut buf);
    let body = format!("{}:{}:{}", VERSION, include_str!("../migrations/version.txt"), std::process::id());
    write!(stream, "HTTP/1.1 200 OK\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}", body.len(), body).unwrap();
  }
}`;
    const mainPath = resolve(backend, 'src/main.rs');
    writeFileSync(mainPath, main);
    execFileSync('cargo', ['generate-lockfile', '--offline'], {
      cwd: backend,
      stdio: 'pipe',
    });
    const child = spawn(process.execPath, [resolve(root, 'runspace/dev.mjs'), 'backend'], {
      env: {
        ...process.env,
        PATH: `${dirname(process.env.RUNSPACE_TEST_BACON)}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGINT');
        await done;
      }
    });
    const response = async () => {
      try {
        return await (await fetch(context.api, { signal: AbortSignal.timeout(300) })).text();
      } catch {
        return '';
      }
    };
    try {
      await waitUntil(async () => (await response()).startsWith('source-one:migration-one:'));
      writeFileSync(mainPath, 'this is a compile error');
      await waitUntil(() => output.includes('could not compile'));
      await waitUntil(() => portAvailable(Number(context.config.API_PORT)));
      writeFileSync(mainPath, main.replace('source-one', 'source-two'));
      await waitUntil(async () => (await response()).startsWith('source-two:migration-one:'));
      writeFileSync(resolve(backend, 'migrations/version.txt'), 'migration-two');
      await waitUntil(async () => (await response()).startsWith('source-two:migration-two:'));
      const before = await response();
      const lock = resolve(backend, 'Cargo.lock');
      writeFileSync(lock, readFileSync(lock, 'utf8') + '\n');
      await waitUntil(async () => {
        const value = await response();
        return value.startsWith('source-two:migration-two:') && value !== before;
      });
      const done = once(child, 'exit');
      child.kill('SIGINT');
      await done;
      assert.equal(await portAvailable(Number(context.config.API_PORT)), true);
      assert.equal(await portAvailable(Number(context.config.METRICS_PORT)), true);
    } catch (error) {
      throw new Error(`${error.message}\nWatcher output:\n${output}`);
    }
  },
);
