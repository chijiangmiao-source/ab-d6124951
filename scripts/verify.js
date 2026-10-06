'use strict';
// 一次性验收服务（verify）：
//   1) 宏卫生场景代码测试（node --test）
//   2) 页面构建（npm run build）
//   3) 在 Compose 内启动服务，对规程页面、健康地址、复核 API 做 HTTP/API 冒烟
//   全部通过 -> exit 0；任一失败 -> exit 1。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { reviewSource } from '../src/review.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    p.on('close', (code) => resolve(code));
  });
}

async function httpJson(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 页面不是 JSON */ }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
}

const checks = [];
function check(name, cond, detail = '') {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // ---- 1) 代码测试 ----
  console.log('\n== [1/4] 宏卫生场景代码测试 ==');
  const tCode = await run(process.execPath, ['--test', 'test/']);
  check('node --test 全部通过', tCode === 0, `exit=${tCode}`);

  // ---- 2) 页面构建 ----
  console.log('\n== [2/4] 规程页面构建 ==');
  const bCode = await run(process.execPath, ['src/build.js']);
  check('页面构建成功并产出 dist/', bCode === 0, `exit=${bCode}`);

  // ---- 3) 冒烟目标：Compose 中使用 BASE_URL 指向 web 服务；独立运行时进程内启动 ----
  console.log('\n== [3/4] HTTP/API 冒烟 ==');
  let server = null;
  let base;
  if (process.env.BASE_URL) {
    base = process.env.BASE_URL.replace(/\/$/, '');
    console.log(`使用 Compose 网络中的 web 服务：${base}`);
    // 等待健康地址就绪（compose 的 depends_on healthy 通常已保证，此处再做一次重试）
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const probe = await httpJson('GET', `${base}/healthz`);
        if (probe.status === 200) break;
      } catch { /* 尚未就绪 */ }
      if (Date.now() > deadline) throw new Error(`等待 ${base}/healthz 就绪超时`);
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    const port = Number(process.env.VERIFY_PORT || 0);
    const started = await startServer({ port, host: '127.0.0.1' });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
    console.log(`进程内服务已启动：${base}`);
  }

  try {
    const health = await httpJson('GET', `${base}/healthz`);
    check('GET /healthz 返回 200 status=ok', health.status === 200 && health.json?.status === 'ok');

    const page = await httpJson('GET', `${base}/`);
    check('GET / 规程页面返回 200 HTML',
      page.status === 200 && page.contentType.includes('text/html') && page.text.includes('宏卫生复核台'),
      `bytes=${page.text.length}`);

    // ---- 4) API 端到端：卫生主场景 + 递归超限隔离 ----
    console.log('\n== [4/4] 复核 API 端到端断言 ==');
    const hygieneSrc = `
(define-syntax with-temp-x
  (syntax-rules ()
    ((with-temp-x body) (let ((x 99)) body))))
(define-syntax capture-probe
  (syntax-rules ()
    ((capture-probe e) (with-temp-x e))))
((lambda (x) (capture-probe x)) 7)
`;
    const api = await httpJson('POST', `${base}/api/review`, { source: hygieneSrc });
    check('POST /api/review 卫生场景 200 且 ok', api.status === 200 && api.json?.ok === true);
    const f = api.json?.forms?.[0];
    const norm = f?.normalizedText || '';
    const tags = [...norm.matchAll(/x#([a-z]+)/g)].map((m) => m[1]);
    check('规范化结果含两个不同 x 身份标签', new Set(tags).size === 2, norm);
    check('模板临时 x 未捕获调用点 x（体内为调用点标签）',
      /lambda \(x#[a-z]+\) x#[a-z]+\)/.test(norm) && norm.includes('99') && norm.endsWith('7)'));
    check('每步展开记录命中规则与调用位置',
      Array.isArray(f?.trace) && f.trace.length === 2 &&
      f.trace.every((t) => t.rule && t.callLoc && t.callSnippet?.line) &&
      /模板内嵌套调用/.test(f.trace[1].callSiteKind));

    const rec = await httpJson('POST', `${base}/api/review`, {
      source: `
(define-syntax loop (syntax-rules () ((loop) (loop))))
(loop)
((lambda (x) x) 42)
`,
    });
    const forms = rec.json?.forms || [];
    check('递归超限形式被定位且报告 RECURSION_LIMIT',
      forms[0]?.ok === false && forms[0]?.error?.code === 'RECURSION_LIMIT' && !!forms[0]?.error?.snippet);
    check('递归超限不阻塞后续合法形式',
      forms[1]?.ok === true && /lambda \(x#/.test(forms[1]?.normalizedText || ''));

    const bad = await httpJson('POST', `${base}/api/review`, { source: '(define-syntax g (syntax-rules (q) ((g) 1)))\n(g)' });
    check('未绑定 literal 返回结构化错误与源片段',
      bad.json?.ok === false && bad.json?.error?.code === 'UNBOUND_LITERAL' && !!bad.json?.error?.snippet);

    // 库级稳定性补充：错误后再次复核合法模块仍成功（无状态）
    const again = reviewSource(hygieneSrc);
    check('异常复核之后的合法模块复核不受影响', again.ok === true && again.forms[0].ok === true);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n==== 验收${failed.length === 0 ? '通过' : '失败'}：${checks.length - failed.length}/${checks.length} 项 ====`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify 执行异常：', e);
  process.exit(1);
});
