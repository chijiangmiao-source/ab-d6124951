'use strict';
// 规程页面 + 健康响应 + 复核 API。零第三方依赖，基于 node:http。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { reviewSource } from './review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const INDEX = path.join(DIST_DIR, 'index.html');
const INDEX_FALLBACK = path.join(PUBLIC_DIR, 'index.html');

export function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function createHandler() {
  let indexCache = null;
  async function getIndex() {
    if (!indexCache) {
      try {
        indexCache = await readFile(INDEX, 'utf8'); // 优先构建产物 dist/
      } catch {
        indexCache = await readFile(INDEX_FALLBACK, 'utf8');
      }
    }
    return indexCache;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      return json(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), service: 'macro-hygiene-review' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const html = await getIndex();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      } catch {
        return json(res, 503, { status: 'error', error: '规程页面尚未构建（先运行 npm run build）' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 1_000_000) return json(res, 413, { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '模块超过 1MB 限制' } });
        chunks.push(c);
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(res, 400, { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
      }
      if (typeof payload.source !== 'string') {
        return json(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '缺少字符串字段 source' } });
      }
      const result = reviewSource(payload.source, {
        maxDepth: payload.maxDepth,
        maxApplications: payload.maxApplications,
      });
      return json(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { status: 'ok' });
    }
    return json(res, 404, { status: 'error', error: 'not found' });
  };
}

export function startServer({ port, host } = {}) {
  const p = Number(port ?? process.env.HOST_PORT ?? process.env.PORT ?? 8080);
  const h = host ?? process.env.HOST ?? '0.0.0.0';
  const server = http.createServer(createHandler());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, h, () => resolve({ server, port: server.address().port, host: h }));
  });
}

// 直接运行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ port, host }) => {
    console.log(`[macro-hygiene-review] 规程页面 http://${host}:${port}/  健康检查 http://${host}:${port}/healthz`);
  }).catch((e) => {
    console.error('启动失败：', e);
    process.exit(1);
  });
}
