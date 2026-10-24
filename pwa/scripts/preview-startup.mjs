import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

// Serve a real production build with isolated fake credentials and API failures.
// This server never proxies requests; preview tokens cannot reach a real backend.
const root = fileURLToPath(new URL('../dist/app/browser/', import.meta.url));
const port = Number(process.env.PORT ?? 14310);
const host = process.env.HOST ?? '0.0.0.0';
const cases = {
  missing: '没有登录信息',
  expired: '登录状态失效（401）',
  network: '连接失败',
  server: '服务暂时不可用（503）',
  failed: '其它登录错误（403）',
  slow: '连接缓慢：10 秒出现提示，15 秒后返回 503',
  timeout: '登录超时：30 秒后可重试',
  retry: '首次 503，点击重试后进入聊天框架',
  'boot-failed': '主脚本加载失败',
  'boot-slow': '主脚本一直未返回：10 秒出现重新加载',
  'catalog-failed': '语言包加载失败',
  landing: '安装指引页',
};
const attempts = new Map();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cookie = req.headers.cookie ?? '';
  const scenario = cookie.match(/(?:^|; )startup_preview=([^;]+)/)?.[1];
  const run = cookie.match(/(?:^|; )startup_run=([^;]+)/)?.[1];
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  };
  const json = (body) => send(200, JSON.stringify(body), 'application/json');
  if (url.pathname === '/') {
    send(
      200,
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>启动页面验证</title><style>body{font:16px system-ui;max-width:720px;margin:48px auto;padding:24px}li{margin:16px 0}</style><h1>茶话启动页面验证</h1><p>使用本地模拟 API 和虚构凭证。选择场景后显示实际应用页面。</p><ul>${Object.entries(
        cases,
      )
        .map(
          ([key, label]) =>
            `<li><a href="/${key === 'landing' ? 'landing' : 'chats'}?scenario=${key}">${label}</a></li>`,
        )
        .join('')}</ul><p>返回此页可切换场景；重试成功只验证聊天框架，后续业务接口不模拟。</p></html>`,
      types['.html'],
    );
    return;
  }
  if (url.pathname.startsWith('/_api/')) {
    if (url.pathname === '/_api/auth/refresh') {
      if (scenario === 'network') return req.socket.destroy();
      if (scenario === 'timeout') return; // The client's deadline cancels this request.
      if (scenario === 'slow') {
        const timer = setTimeout(() => send(503, 'Simulated service outage'), 15000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (scenario === 'retry') {
        const count = attempts.get(run) ?? 0;
        attempts.set(run, count + 1);
        if (count > 0) return json({ token: 'preview-token' });
      }
      return send(scenario === 'expired' ? 401 : scenario === 'failed' ? 403 : 503, 'Simulated login failure');
    }
    if (scenario === 'retry' && url.pathname === '/_api/users/me') {
      return json({
        uid: 1,
        username: '预览用户',
        gender: 0,
        permissions: [],
        stickerPackOrder: [],
        muteGroupChatsByDefault: true,
        muteDirectChatsByDefault: false,
      });
    }
    if (scenario === 'retry' && url.pathname === '/_api/users/search') return json({ members: [], excluded: [] });
    return send(503, 'Business APIs are not simulated');
  }
  // Do not install the production caching/update worker in the simulation origin.
  if (url.pathname === '/ngsw.json') return send(404, 'No worker manifest in preview');
  if (url.pathname === '/serviceWorker.js') return send(200, '// Preview: no caching or push.', types['.js']);
  if (/\/main[^/]*\.js$/.test(url.pathname)) {
    if (scenario === 'boot-failed') return send(503, 'Simulated bundle failure');
    if (scenario === 'boot-slow') return;
  }
  if (scenario === 'catalog-failed' && url.pathname.startsWith('/i18n/')) return send(503, 'Simulated catalog failure');

  const isPage = url.pathname === '/chats' || url.pathname === '/landing';
  const path = isPage ? resolve(root, 'index.html') : resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return send(403, 'Forbidden');
  try {
    let body = await readFile(path);
    if (isPage) {
      const selected = url.searchParams.get('scenario') ?? scenario ?? 'missing';
      if (!Object.hasOwn(cases, selected)) return send(400, 'Unknown scenario');
      const id = String(Date.now());
      attempts.clear();
      res.setHeader('Set-Cookie', [
        `startup_preview=${selected}; Path=/; SameSite=Lax`,
        `startup_run=${id}; Path=/; SameSite=Lax`,
      ]);
      // Inject only in this local server; no simulation switches ship in the app.
      const setup = `<script>localStorage.removeItem('chahua.auth.token');document.cookie='chahua.auth.token=;Path=/;Max-Age=0';localStorage.setItem('chahua.preferences.locale','zh-CN');localStorage.setItem('chahua.notifications.enabled','false');localStorage.${selected === 'missing' ? "removeItem('jwt_token')" : "setItem('jwt_token','preview-token')"};document.cookie='jwt_token=;Path=/;Max-Age=0';</script>`;
      body = body.toString().replace('<head>', `<head>${setup}`);
    }
    send(200, body, types[extname(path)] ?? 'application/octet-stream');
  } catch {
    send(404, 'Build the PWA first: npm run build');
  }
});
server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请停止已有预览服务，或使用 PORT=${port + 1} npm run preview:startup-failures。`
      : `预览服务启动失败：${error.message}`,
  );
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(`Startup preview listening on ${host}:${port}`);
  if (host === '0.0.0.0') {
    console.log(`Local: http://localhost:${port}`);
    for (const address of Object.values(networkInterfaces()).flat()) {
      if (address?.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${port}`);
    }
  } else {
    console.log(`Preview: http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
});
