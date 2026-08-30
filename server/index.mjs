#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../scripts/lib/store.mjs';
import { CommandService } from '../scripts/lib/commands.mjs';
import { createRouter, sendJson } from './app.mjs';
import { TaskReadService } from './services/task-read-service.mjs';
import { ApprovalReadService } from './services/approval-read-service.mjs';
import { ConsoleCommandService } from './services/console-command-service.mjs';
import { EventStreamService } from './services/event-stream-service.mjs';
import { IdempotencyService } from './services/idempotency-service.mjs';
import { makeCsrfToken } from './middleware/request-context.mjs';
import * as healthRoutes from './routes/health.mjs';
import * as overviewRoutes from './routes/overview.mjs';
import * as taskRoutes from './routes/tasks.mjs';
import * as approvalRoutes from './routes/approvals.mjs';
import * as commandRoutes from './routes/commands.mjs';
import * as eventRoutes from './routes/events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/**
 * Network boundary (docs §11.1, review F-07): the console is a local,
 * unauthenticated single-owner tool. Non-loopback binds are refused at
 * startup; LAN support would require auth, TLS and owner authorization as
 * a separate mode.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function assertLoopbackHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    process.stderr.write(`Refusing to start: --host ${host} is not a loopback address.\n` +
      'The console API has no authentication and must only listen on 127.0.0.1, localhost or ::1.\n');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const options = { host: '127.0.0.1', port: 4174, static: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--host') options.host = argv[++i];
    else if (token === '--port') options.port = Number(argv[++i]);
    else if (token === '--no-static') options.static = false;
    else if (token === '--help' || token === '-h') options.help = true;
  }
  return options;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

async function serveStatic(distDir, req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  let filePath = path.normalize(path.join(distDir, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  let stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.isDirectory()) {
    filePath = path.join(distDir, 'index.html');
    stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  res.end(await fs.readFile(filePath));
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`welink-office-agent console API\n\nUsage:\n  node server/index.mjs [--host 127.0.0.1] [--port 4174] [--no-static]\n\nServes the console API under /api/v1. With --static (default) it also\nhosts web-console/dist/ for same-origin production-style local runs.\nOnly loopback hosts (127.0.0.1, localhost, ::1) are allowed.\n`);
    return;
  }
  assertLoopbackHost(options.host);

  const store = new Store(projectRoot);
  await store.initialize();
  const commandService = new CommandService(store);

  const context = {
    store,
    commandService,
    consoleCommandService: new ConsoleCommandService(store, commandService),
    taskReadService: new TaskReadService(store),
    approvalReadService: new ApprovalReadService(store),
    eventStreamService: new EventStreamService(store),
    idempotencyService: null,
    makeRequestId: () => `REQ-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    csrfToken: makeCsrfToken(),
    mode: 'local',
    get ownerEmployeeNumber() {
      return this._owner;
    }
  };
  try {
    const ownerConfig = await store.loadConfig('owner');
    context._owner = ownerConfig.owner_employee_number ?? null;
    context.ownerConfig = ownerConfig;
  } catch {
    context._owner = null;
    context.ownerConfig = {};
  }
  context.idempotencyService = new IdempotencyService(store, { owner: context._owner ?? 'local' });
  try {
    context.contactsConfig = await store.loadConfig('contacts');
  } catch {
    context.contactsConfig = {};
  }

  const router = createRouter(context);
  router.registerAll(healthRoutes);
  router.registerAll(overviewRoutes);
  router.registerAll(taskRoutes);
  router.registerAll(approvalRoutes);
  router.registerAll(commandRoutes);
  router.registerAll(eventRoutes);

  const distDir = path.join(projectRoot, 'web-console', 'dist');
  let staticAvailable = false;
  if (options.static) {
    staticAvailable = await fs.stat(path.join(distDir, 'index.html')).then(() => true, () => false);
  }

  const server = http.createServer(async (req, res) => {
    const isApi = req.url.startsWith('/api/');
    if (!isApi && staticAvailable) {
      try {
        const served = await serveStatic(distDir, req, res);
        if (served) return;
      } catch (error) {
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '静态资源读取失败。', retryable: false, details: null } });
        return;
      }
    }
    if (!isApi && !staticAvailable) {
      sendJson(res, 404, {
        error: {
          code: 'STATIC_NOT_BUILT',
          message: '控制台前端尚未构建（web-console/dist 不存在）。先在 web-console/ 运行 npm run build，或使用 Vite 开发服务器。',
          retryable: false,
          details: null
        }
      });
      return;
    }
    await router.handle(req, res);
  });

  await new Promise((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  // Belt and suspenders: whatever was requested, verify what actually bound.
  if (!address || !LOOPBACK_HOSTS.has(address.address)) {
    process.stderr.write(`Refusing to serve: bound address ${address?.address ?? 'unknown'} is not loopback.\n`);
    server.close();
    process.exit(1);
  }
  await context.eventStreamService.start();

  const stop = () => {
    context.eventStreamService.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  process.stdout.write(`Console API listening on http://${address.address}:${address.port}\n`);
  process.stdout.write(`Runtime: ${store.runtimeDir}\n`);
  process.stdout.write(`Static hosting: ${staticAvailable ? path.relative(projectRoot, distDir) : 'disabled'}\n`);
}

main().catch((error) => {
  console.error('[console-api] failed to start:', error);
  process.exitCode = 1;
});
