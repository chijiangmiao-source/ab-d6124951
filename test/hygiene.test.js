'use strict';
// 宏卫生场景代码测试（node:test，无第三方依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewSource } from '../src/review.js';

const HYGIENE = `
(define-syntax with-temp-x
  (syntax-rules ()
    ((with-temp-x body)
     (let ((x 99)) body))))

(define-syntax capture-probe
  (syntax-rules ()
    ((capture-probe e)
     (with-temp-x e))))

((lambda (x)
   (capture-probe x))
 7)
`;

test('嵌套宏：调用点 x 与模板临时 x 获得不同绑定身份', () => {
  const r = reviewSource(HYGIENE);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.forms.length, 1);
  const f = r.forms[0];
  assert.equal(f.ok, true, JSON.stringify(f.error));
  // ((lambda (x#call) ((lambda (x#tpl) x#call) 99)) 7)
  assert.match(f.normalizedText, /^\(\(lambda \(x#([a-z]+)\) \(\(lambda \(x#([a-z]+)\) x#\1\) 99\)\) 7\)$/);
  const tags = [...f.normalizedText.matchAll(/x#([a-z]+)/g)].map((m) => m[1]);
  const uniq = new Set(tags);
  assert.equal(uniq.size, 2, `两个 x 必须有两个不同身份标签，实际：${tags}`);
  // 身份来源说明
  const origins = f.identities.map((i) => i.origin).join('|');
  assert.match(origins, /调用点绑定/);
  assert.match(origins, /模板新作用域/);
});

test('模式变量保留调用点绑定：模板体内 x 引用解析到调用点 λ 参数', () => {
  const r = reviewSource(HYGIENE);
  const f = r.forms[0];
  const callTag = f.identities.find((i) => /调用点绑定/.test(i.origin));
  assert.ok(callTag);
  // 规范化结果中内层 lambda 体内出现的 x 必须是调用点标签
  assert.match(f.normalizedText, new RegExp(`lambda \\(x#[a-z]+\\) x#${callTag.tag}\\)`));
});

test('模板新绑定获得稳定的新作用域：相同输入两次复核身份标签一致', () => {
  const a = reviewSource(HYGIENE).forms[0].normalizedText;
  const b = reviewSource(HYGIENE).forms[0].normalizedText;
  assert.equal(a, b);
});

test('展开步骤记录命中规则与调用位置，且区分调用点与模板内嵌套调用', () => {
  const f = reviewSource(HYGIENE).forms[0];
  assert.equal(f.trace.length, 2);
  assert.equal(f.trace[0].macro, 'capture-probe');
  assert.equal(f.trace[0].rule, 1);
  assert.match(f.trace[0].callSiteKind, /模块调用点/);
  assert.equal(f.trace[1].macro, 'with-temp-x');
  assert.equal(f.trace[1].rule, 1);
  assert.match(f.trace[1].callSiteKind, /模板内嵌套调用/);
  for (const t of f.trace) {
    assert.ok(t.callSnippet && t.callSnippet.line >= 1);
    assert.ok(Number.isInteger(t.callLoc.offset));
  }
});

const LITERAL = `
(define-syntax branch-on
  (syntax-rules (if)
    ((branch-on if consequent) consequent)
    ((branch-on _ e) e)))

((lambda (if)
   (branch-on if 123))
 'local-if)

(branch-on if 456)
`;

test('literal 按词法绑定而非拼写匹配：局部同名遮蔽不命中 literal', () => {
  const r = reviewSource(LITERAL);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // 形式 1：局部 if 遮蔽核心 if -> 规则 1 literal 不匹配 -> 规则 2
  const t1 = r.forms[0].trace[0];
  assert.equal(t1.rule, 2);
  assert.match(r.forms[0].normalizedText, /123/);
  // 形式 2：顶层 if 与 literal 同身份 -> 规则 1
  const t2 = r.forms[1].trace[0];
  assert.equal(t2.rule, 1);
  assert.match(r.forms[1].normalizedText, /^456$/);
});

test('未绑定 literal：定位到 literal 标识符并给出证据', () => {
  const r = reviewSource(`
(define-syntax param
  (syntax-rules (knobs/switch)
    ((param knobs/switch) 'ok)))
(param knobs/switch)
`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNBOUND_LITERAL');
  assert.ok(r.error.snippet);
  assert.match(r.error.message, /knobs\/switch/);
});

test('规则无匹配：报告每条规则失败原因并定位宏调用点', () => {
  const r = reviewSource(`
(define-syntax sel
  (syntax-rules ()
    ((sel a b) (cons a b))))
(sel 1)
`);
  const f = r.forms[0];
  assert.equal(f.ok, false);
  assert.equal(f.error.code, 'NO_MATCHING_RULE');
  assert.match(f.error.evidence.join('\n'), /长度不匹配/);
  assert.ok(f.error.snippet);
});

test('重复变量长度不一致：REP_LENGTH_MISMATCH 且定位模板重复段', () => {
  const r = reviewSource(`
(define-syntax zip3
  (syntax-rules ()
    ((zip3 (a ...) (b ...))
     (pair (a b) ...))))
(zip3 (1 2 3) (4 5))
`);
  const f = r.forms[0];
  assert.equal(f.ok, false);
  assert.equal(f.error.code, 'REP_LENGTH_MISMATCH');
  assert.match(f.error.message, /长度不一致/);
  assert.ok(f.error.snippet);
});

test('递归超限：当前形式报 RECURSION_LIMIT，后续合法形式仍正常展开', () => {
  const r = reviewSource(`
(define-syntax loop
  (syntax-rules ()
    ((loop) (loop))))
(loop)
((lambda (x) x) 42)
`);
  assert.equal(r.ok, true);
  assert.equal(r.forms.length, 2);
  assert.equal(r.forms[0].ok, false);
  assert.equal(r.forms[0].error.code, 'RECURSION_LIMIT');
  assert.ok(r.forms[0].error.snippet);
  assert.equal(r.forms[1].ok, true, JSON.stringify(r.forms[1].error));
  assert.match(r.forms[1].normalizedText, /^\(\(lambda \(x#[a-z]+\) x#[a-z]+\) 42\)$/);
});

test('递归超限不阻塞后续独立模块复核（服务无状态）', () => {
  const bad = reviewSource(`
(define-syntax loop (syntax-rules () ((loop) (loop))))
(loop)`);
  assert.equal(bad.forms[0].error.code, 'RECURSION_LIMIT');
  const good = reviewSource(HYGIENE);
  assert.equal(good.ok, true);
  assert.equal(good.forms[0].ok, true);
});

test('语法不完整：PARSE_ERROR 定位首个相关源片段，无展开结论', () => {
  const r = reviewSource(`
(define-syntax bad
  (syntax-rules ()
    ((bad x) x)

(bad 1)
`);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PARSE_ERROR');
  assert.ok(r.error.snippet.line >= 1);
  assert.ok(!('forms' in r));
});

test('宏数量上限 12 与规则上限 8', () => {
  const manyMacros = Array.from({ length: 13 }, (_, i) =>
    `(define-syntax m${i} (syntax-rules () ((m${i} x) x)))`).join('\n') + '\n(m0 1)';
  const r1 = reviewSource(manyMacros);
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'TOO_MANY_MACROS');

  const rules = Array.from({ length: 9 }, (_, i) => `((g x) ${i})`).join('\n    ');
  const r2 = reviewSource(`
(define-syntax g (syntax-rules () ${rules}))
(g 1)
`);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'TOO_MANY_RULES');
});

test('一层重复：同长度重复变量正常实例化', () => {
  const r = reviewSource(`
(define-syntax zip2
  (syntax-rules ()
    ((zip2 (a ...) (b ...))
     (pair (a b) ...))))
(zip2 (1 2) (3 4))
`);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.forms[0].ok, true, JSON.stringify(r.forms[0].error));
  assert.match(r.forms[0].normalizedText, /^\(pair#[a-z]+ \(1 3\) \(2 4\)\)$/);
});

test('规范化输出将 let 归约为 lambda 立即调用', () => {
  const r = reviewSource(`(let ((y 5)) y)`);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const out = r.forms[0].normalizedText;
  assert.doesNotMatch(out, /let/);
  assert.match(out, /lambda/);
});
