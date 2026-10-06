'use strict';
// 一次性页面构建：校验页面资源、输出到 dist/ 并写入构建清单（含内容指纹）。
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_HTML = path.join(ROOT, 'public', 'index.html');
const DIST_DIR = path.join(ROOT, 'dist');

async function main() {
  const html = await readFile(SRC_HTML, 'utf8');

  // 轻量完整性校验：关键挂载点与脚本必须存在，括号/标签粗检
  const required = ['id="src"', 'id="out"', '/api/review', 'EXAMPLES', '<!doctype html>', '</html>'];
  const missing = required.filter((t) => !html.includes(t));
  if (missing.length) {
    throw new Error(`页面构建失败：缺少关键内容 ${missing.join(', ')}`);
  }
  const opens = (html.match(/<section\b/g) || []).length;
  const closes = (html.match(/<\/section>/g) || []).length;
  if (opens !== closes) throw new Error('页面构建失败：<section> 标签不配对');

  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(path.join(DIST_DIR, 'index.html'), html, 'utf8');

  const hash = createHash('sha256').update(html).digest('hex').slice(0, 16);
  const manifest = {
    name: 'macro-hygiene-review',
    builtAt: new Date().toISOString(),
    pages: ['index.html'],
    sha256: { 'index.html': hash },
    bytes: Buffer.byteLength(html),
  };
  await writeFile(path.join(DIST_DIR, 'build-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[build] dist/index.html 已生成（${manifest.bytes} 字节，sha256:${hash}）`);
  try {
    await access(path.join(DIST_DIR, 'index.html'));
  } catch {
    throw new Error('构建产物不可读');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
