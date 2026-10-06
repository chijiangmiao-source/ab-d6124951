'use strict';
// 卫生宏展开器（受限 syntax-rules，支持一层重复 ...）
//
// 卫生算法（显式重命名 + 词法身份）：
//   - 每个标识符携带“绑定身份”(sym)。两个标识符相同 <=> 同一 sym。
//   - 调用点表达式先做词法解析：lambda/let 的约束发生成调用点 sym，
//     作为宏实参替换进模板后身份不变（模式变量保留调用点绑定）。
//   - 模板实例化时，模板字面量经定义处词法环境解析；模板内新引入的
//     lambda/let 约束发生成“稳定的新作用域”sym，只捕获模板自身的
//     字面量引用，不会捕获经模式变量带入的调用点同名标识符。
//   - literal 按词法身份匹配（free-identifier=?）：被调用点局部约束
//     同名遮蔽的标识符不会命中 literal；literal 必须在定义处有绑定。

import { isList, sourceSnippet } from './parser.js';

export const CORE_KEYWORDS = new Set([
  'lambda', 'λ', 'let', 'quote', 'if', 'begin', 'set!',
  'define', 'and', 'or', 'define-syntax', 'syntax-rules',
]);

let SYM_SEQ = 0;
function sym(name, origin, extra = {}) {
  return { id: `s${++SYM_SEQ}`, name, origin, ...extra };
}

// 每次复核重置，使身份编号稳定（同输入 => 同编号 => 稳定证据）
export function resetIdentityCounter() { SYM_SEQ = 0; }

export class ReviewError extends Error {
  constructor(code, message, loc, evidence = []) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.loc = loc; // {offset,end}
    this.evidence = evidence;
  }
}

const ELLIPSIS = '...';

function locOf(node) {
  if (!node) return null;
  if (node.kind === 'list') {
    if (Number.isInteger(node.open)) return { offset: node.open, end: node.close };
    if (node.loc) return { offset: node.loc.offset, end: node.loc.end };
    return null;
  }
  return node.loc ? { offset: node.loc.offset, end: node.loc.end } : null;
}
function cloneId(node, s) {
  return { kind: 'id', name: node.name, sym: s, loc: node.loc };
}
function cloneLit(node) {
  return { kind: 'lit', value: node.value, loc: node.loc };
}

// ---------------------------------------------------------------------------
// 定义处词法环境：核心关键字 + 本模块宏；自由量按名共享同一顶层身份
// ---------------------------------------------------------------------------
function buildDefinitionEnv(macros) {
  const env = new Map();
  for (const kw of CORE_KEYWORDS) env.set(kw, sym(kw, 'core'));
  for (const m of macros) env.set(m.name, m.symRef);
  const free = new Map();
  return {
    symOf(name) {
      if (env.has(name)) return env.get(name);
      if (!free.has(name)) free.set(name, sym(name, 'free'));
      return free.get(name);
    },
    isBound(name) { return env.has(name); },
  };
}

// ---------------------------------------------------------------------------
// 调用点词法解析：为源表达式中每个标识符确定绑定身份
// ---------------------------------------------------------------------------
function resolveExpression(node, env, defEnv) {
  if (node.kind !== 'list') {
    if (node.kind === 'id') {
      return cloneId(node, env.get(node.name) || defEnv.symOf(node.name));
    }
    return cloneLit(node);
  }
  const items = node.items;
  const head = items[0];

  if (head && head.kind === 'id' && (head.name === 'lambda' || head.name === 'λ')) {
    const paramList = items[1];
    if (!isList(paramList)) {
      throw new ReviewError('BAD_SYNTAX', 'lambda 需要形参表 (lambda (x ...) body)', locOf(paramList) || locOf(node));
    }
    const inner = new Map(env);
    const params = [];
    for (const p of paramList.items) {
      if (p.kind !== 'id') throw new ReviewError('BAD_SYNTAX', 'lambda 形参必须是标识符', locOf(p));
      const s = sym(p.name, 'lambda', { loc: locOf(p) });
      inner.set(p.name, s);
      params.push(cloneId(p, s));
    }
    const bodies = items.slice(2).map((b) => resolveExpression(b, inner, defEnv));
    return {
      kind: 'list',
      items: [cloneId(head, defEnv.symOf('lambda')), { kind: 'list', items: params }, ...bodies],
      loc: node.loc,
    };
  }

  if (head && head.kind === 'id' && head.name === 'let') {
    const bindList = items[1];
    if (!isList(bindList)) {
      throw new ReviewError('BAD_SYNTAX', 'let 需要绑定表 (let ((x e) ...) body)', locOf(bindList) || locOf(node));
    }
    const binders = [];
    const rhsResolved = [];
    for (const b of bindList.items) {
      if (!isList(b) || b.items.length !== 2 || b.items[0].kind !== 'id') {
        throw new ReviewError('BAD_SYNTAX', 'let 绑定必须形如 (x e)', locOf(b));
      }
      binders.push(b.items[0]);
      rhsResolved.push(resolveExpression(b.items[1], env, defEnv)); // rhs 不见新绑定
    }
    const inner = new Map(env);
    const binderIds = binders.map((p) => {
      const s = sym(p.name, 'let', { loc: locOf(p) });
      inner.set(p.name, s);
      return cloneId(p, s);
    });
    const bodies = items.slice(2).map((b) => resolveExpression(b, inner, defEnv));
    return {
      kind: 'list',
      items: [
        cloneId(head, defEnv.symOf('let')),
        { kind: 'list', items: binderIds.map((id, i) => ({ kind: 'list', items: [id, rhsResolved[i]] })) },
        ...bodies,
      ],
      loc: node.loc,
    };
  }

  // 普通调用（含宏调用）；宏实参是语法片段，其内部局部绑定在此确定
  return { kind: 'list', items: items.map((it) => resolveExpression(it, env, defEnv)), loc: node.loc };
}

// ---------------------------------------------------------------------------
// 静态校验
// ---------------------------------------------------------------------------
function containsEllipsis(node) {
  if (node.kind === 'id') return node.name === ELLIPSIS;
  if (node.kind === 'list') return node.items.some(containsEllipsis);
  return false;
}

// 把表拆为段：{ node, repeat, ellipsisLoc }；... 作用于紧邻前一个子模式
function segmentsOf(listForm, what) {
  const segs = [];
  for (const it of listForm.items) {
    if (it.kind === 'id' && it.name === ELLIPSIS) {
      if (segs.length === 0 || segs[segs.length - 1].repeat) {
        throw new ReviewError(
          'BAD_MACRO',
          segs.length === 0 ? `${what}中的 ... 缺少其修饰的子形式` : `${what}中出现多层重复（仅允许一层 ...）`,
          locOf(it),
        );
      }
      segs[segs.length - 1].repeat = true;
      segs[segs.length - 1].ellipsisLoc = locOf(it);
      continue;
    }
    segs.push({ node: it, repeat: false });
  }
  return segs;
}

function collectPatternVars(pat, literalNames, state, underRepeat = false) {
  if (pat.kind === 'lit') return;
  if (pat.kind === 'id') {
    const name = pat.name;
    if (name === ELLIPSIS) throw new ReviewError('BAD_MACRO', '孤立的 ... 不合法', locOf(pat));
    if (name === '_') return;
    if (literalNames.has(name)) return;
    if (state.bound.has(name)) {
      throw new ReviewError(
        'BAD_MACRO',
        `模式变量 ${name} 在同一模式中重复出现`,
        locOf(pat),
        [`首次出现于偏移 ${state.bound.get(name).loc.offset}`],
      );
    }
    state.bound.set(name, { repeat: underRepeat, loc: locOf(pat) });
    return;
  }
  const segs = segmentsOf(pat, '模式');
  let repeatSegs = 0;
  for (const seg of segs) {
    if (seg.repeat) {
      repeatSegs++;
      if (containsEllipsis(seg.node)) {
        throw new ReviewError('BAD_MACRO', '出现多层重复（仅允许一层 ...）', locOf(seg.node));
      }
    }
    collectPatternVars(seg.node, literalNames, state, underRepeat || seg.repeat);
  }
  // 同一层至多一个重复段（无歧义）；多个重复变量可置于段内嵌套表，如 (m (a ...) (b ...))
  if (repeatSegs > 1) {
    throw new ReviewError('BAD_MACRO', '一个模式表中至多允许一个重复段 (...) ...；多个重复变量请放入该段内', locOf(pat));
  }
}

function hasRepeatVarRef(node, boundVars) {
  if (node.kind === 'id') return !!boundVars.get(node.name)?.repeat;
  if (node.kind === 'list') return node.items.some((i) => hasRepeatVarRef(i, boundVars));
  return false;
}

function checkTemplate(tpl, boundVars, macroName) {
  function walk(node, depth) {
    if (node.kind === 'lit') return;
    if (node.kind === 'id') {
      const name = node.name;
      if (name === ELLIPSIS) throw new ReviewError('BAD_MACRO', `宏 ${macroName} 模板中存在孤立的 ...`, locOf(node));
      if (name === '_') return;
      const bv = boundVars.get(name);
      if (bv && bv.repeat && depth === 0) {
        throw new ReviewError('BAD_MACRO', `重复模式变量 ${name} 只能在 ... 重复子模板内使用`, locOf(node));
      }
      return;
    }
    const segs = segmentsOf(node, '模板');
    let repeated = 0;
    for (const seg of segs) {
      if (seg.repeat) {
        repeated++;
        if (containsEllipsis(seg.node)) {
          throw new ReviewError('BAD_MACRO', `宏 ${macroName} 模板出现多层重复（仅允许一层 ...）`, locOf(seg.node));
        }
        if (!hasRepeatVarRef(seg.node, boundVars)) {
          throw new ReviewError(
            'BAD_MACRO',
            `宏 ${macroName} 的重复子模板未引用任何重复模式变量，重复次数无法确定`,
            locOf(seg.node),
          );
        }
        walk(seg.node, depth + 1);
      } else {
        walk(seg.node, depth);
      }
    }
    if (repeated > 1) throw new ReviewError('BAD_MACRO', `宏 ${macroName} 一个模板表中至多允许一个重复段`, locOf(node));
  }
  walk(tpl, 0);
}

// ---------------------------------------------------------------------------
// 模式匹配（输入已做调用点词法解析，id 带 sym）
// ---------------------------------------------------------------------------
function matchPattern(pat, input, pv, literalSyms, reasons) {
  if (pat.kind === 'lit') {
    if (input.kind !== 'lit' || input.value !== pat.value) {
      reasons.push(`字面量 ${pat.value} 不匹配`);
      return false;
    }
    return true;
  }
  if (pat.kind === 'id') {
    const name = pat.name;
    if (name === '_') return true;
    if (literalSyms.has(name)) {
      const want = literalSyms.get(name);
      if (input.kind !== 'id' || input.sym.id !== want.id) {
        reasons.push(input.kind === 'id'
          ? `literal ${name} 按词法身份不匹配：输入 ${input.name} 已被局部同名绑定遮蔽`
          : `literal ${name} 需要标识符`);
        return false;
      }
      return true;
    }
    if (pv.has(name)) throw new ReviewError('BAD_MACRO', `模式变量 ${name} 重复`, locOf(pat));
    pv.set(name, { repeat: false, value: input });
    return true;
  }
  if (input.kind !== 'list') {
    reasons.push('模式要求列表形式');
    return false;
  }
  const segs = segmentsOf(pat, '模式');
  const inItems = input.items;
  const repeatIdx = segs.findIndex((s) => s.repeat);

  if (repeatIdx === -1) {
    if (segs.length !== inItems.length) {
      reasons.push(`表长度不匹配：模式 ${segs.length} 项，实际 ${inItems.length} 项`);
      return false;
    }
    return segs.every((seg, i) => matchPattern(seg.node, inItems[i], pv, literalSyms, reasons));
  }
  const fixedBefore = repeatIdx;
  const fixedAfter = segs.length - repeatIdx - 1;
  const repCount = inItems.length - fixedBefore - fixedAfter;
  if (repCount < 0) {
    reasons.push(`重复段至少需要 ${fixedBefore + fixedAfter} 个实参，实际 ${inItems.length} 个`);
    return false;
  }
  for (let i = 0; i < fixedBefore; i++) {
    if (!matchPattern(segs[i].node, inItems[i], pv, literalSyms, reasons)) return false;
  }
  const sub = segs[repeatIdx].node;
  for (let k = 0; k < repCount; k++) {
    const localPv = new Map();
    const localReasons = [];
    if (!matchPattern(sub, inItems[fixedBefore + k], localPv, literalSyms, localReasons)) {
      reasons.push(`第 ${k + 1} 个重复元素不匹配：${localReasons.join('；')}`);
      return false;
    }
    for (const [name, entry] of localPv) {
      if (!pv.has(name)) pv.set(name, { repeat: true, values: [] });
      pv.get(name).values.push(entry.value);
    }
  }
  for (let j = 0; j < fixedAfter; j++) {
    if (!matchPattern(segs[repeatIdx + 1 + j].node, inItems[fixedBefore + repCount + j], pv, literalSyms, reasons)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 模板实例化
// ---------------------------------------------------------------------------
function collectRepeatRefs(node, pv, acc = new Set()) {
  if (node.kind === 'id') {
    if (pv.get(node.name)?.repeat) acc.add(node.name);
  } else if (node.kind === 'list') {
    for (const it of node.items) {
      if (it.kind === 'id' && it.name === ELLIPSIS) continue;
      collectRepeatRefs(it, pv, acc);
    }
  }
  return acc;
}

function instantiate(node, pv, tplEnv, ctx) {
  if (node.kind === 'lit') return cloneLit(node);
  if (node.kind === 'id') {
    if (pv.has(node.name) && !pv.get(node.name).repeat) {
      return pv.get(node.name).value; // 模式变量：原样带入调用点片段与身份
    }
    const s = tplEnv.get(node.name) || ctx.defEnv.symOf(node.name);
    const id = cloneId(node, s);
    id.fromTemplate = true; // 来源：宏定义模板（定义处），用于标注调用位置类型
    return id;
  }
  const rawSegs = node.items;
  const out = [];
  for (let i = 0; i < rawSegs.length; i++) {
    const cur = rawSegs[i];
    const next = rawSegs[i + 1];
    const isRep = next && next.kind === 'id' && next.name === ELLIPSIS;
    if (!isRep) {
      out.push(instantiateForm(cur, pv, tplEnv, ctx));
      continue;
    }
    const refs = [...collectRepeatRefs(cur, pv)];
    let len = null;
    for (const name of refs) {
      const entry = pv.get(name);
      if (!entry?.repeat) throw new ReviewError('EXPAND_ERROR', `变量 ${name} 不是可重复变量`, locOf(cur));
      if (len === null) len = entry.values.length;
      else if (len !== entry.values.length) {
        throw new ReviewError(
          'REP_LENGTH_MISMATCH',
          `重复变量长度不一致：${name} 有 ${entry.values.length} 项，同段其它变量为 ${len} 项`,
          locOf(cur),
          refs.map((r) => `${r}=${pv.get(r)?.values?.length ?? '?'}`),
        );
      }
    }
    const n = len ?? 0;
    for (let k = 0; k < n; k++) {
      const scalarPv = new Map(pv);
      for (const name of refs) scalarPv.set(name, { repeat: false, value: pv.get(name).values[k] });
      out.push(instantiateForm(cur, scalarPv, new Map(tplEnv), ctx));
    }
    i++; // 跳过 ...
  }
  return { kind: 'list', items: out, open: node.open, close: node.close };
}

// 实例化单个形式；识别模板内 lambda/let，为模板新绑定铸造稳定新作用域
function instantiateForm(node, pv, tplEnv, ctx) {
  if (node.kind !== 'list') return instantiate(node, pv, tplEnv, ctx);
  const head = node.items[0];

  if (head && head.kind === 'id' && (head.name === 'lambda' || head.name === 'λ')) {
    const paramList = node.items[1];
    if (!isList(paramList)) {
      throw new ReviewError('EXPAND_ERROR', '模板中 lambda 需要形参表', locOf(paramList) || locOf(node));
    }
    const plSegs = segmentsOf(paramList, '模板形参表');
    const inner = new Map(tplEnv);
    const params = [];
    if (plSegs.length === 1 && plSegs[0].repeat) {
      // (x ...)：x 为标量模式变量，值须是标识符列表；每个形参仍获模板新作用域
      const sub = plSegs[0].node;
      if (sub.kind !== 'id') throw new ReviewError('EXPAND_ERROR', '仅支持 (p ...) 形式的重复形参', locOf(sub));
      const entry = pv.get(sub.name);
      if (!entry || entry.repeat || entry.value.kind !== 'list') {
        throw new ReviewError('EXPAND_ERROR', `重复形参 ${sub.name} 需要列表实参`, locOf(sub));
      }
      for (const frag of entry.value.items) {
        if (frag.kind !== 'id') throw new ReviewError('EXPAND_ERROR', '重复形参展开后必须全部为标识符', locOf(frag));
        const s = sym(frag.name, 'template', { macro: ctx.macro, rule: ctx.rule, loc: locOf(frag) });
        inner.set(frag.name, s);
        params.push(cloneId(frag, s));
      }
    } else {
      for (const seg of plSegs) {
        if (seg.repeat) throw new ReviewError('EXPAND_ERROR', '形参表重复形式受限', locOf(seg.node));
        const p = seg.node;
        if (p.kind !== 'id') throw new ReviewError('EXPAND_ERROR', 'lambda 形参必须是标识符', locOf(p));
        const s = sym(p.name, 'template', { macro: ctx.macro, rule: ctx.rule, loc: locOf(p) });
        inner.set(p.name, s);
        const fromVar = pv.get(p.name);
        const spellingNode = fromVar && !fromVar.repeat ? fromVar.value : p;
        if (spellingNode.kind !== 'id') throw new ReviewError('EXPAND_ERROR', 'lambda 形参必须是标识符', locOf(p));
        params.push(cloneId(spellingNode, s));
      }
    }
    const body = node.items.slice(2).map((b) => instantiate(b, pv, inner, ctx));
    return {
      kind: 'list',
      items: [cloneId(head, ctx.defEnv.symOf('lambda')), { kind: 'list', items: params }, ...body],
      loc: node.loc,
    };
  }

  if (head && head.kind === 'id' && head.name === 'let') {
    const bindList = node.items[1];
    if (!isList(bindList)) throw new ReviewError('EXPAND_ERROR', '模板中 let 需要绑定表', locOf(bindList) || locOf(node));
    const inner = new Map(tplEnv);
    const binds = [];
    for (const b of bindList.items) {
      if (b.kind !== 'list' || b.items.length !== 2 || b.items[0].kind !== 'id') {
        throw new ReviewError('EXPAND_ERROR', 'let 绑定必须形如 (x e)', locOf(b));
      }
      const p = b.items[0];
      const s = sym(p.name, 'template', { macro: ctx.macro, rule: ctx.rule, loc: locOf(p) });
      inner.set(p.name, s);
      const fromVar = pv.get(p.name);
      const spellingNode = fromVar && !fromVar.repeat ? fromVar.value : p;
      binds.push({
        kind: 'list',
        items: [cloneId(spellingNode, s), instantiate(b.items[1], pv, tplEnv, ctx)],
      });
    }
    const body = node.items.slice(2).map((b2) => instantiate(b2, pv, inner, ctx));
    return {
      kind: 'list',
      items: [cloneId(head, ctx.defEnv.symOf('let')), { kind: 'list', items: binds }, ...body],
      loc: node.loc,
    };
  }

  return instantiate(node, pv, tplEnv, ctx);
}

// ---------------------------------------------------------------------------
// 规范化：let -> ((lambda (x...) body...) e...)
// ---------------------------------------------------------------------------
function desugarLet(node) {
  if (node.kind !== 'list') return node;
  const items = node.items.map(desugarLet);
  const head = items[0];
  if (head && head.kind === 'id' && head.sym?.origin === 'core' && head.name === 'let') {
    const binds = items[1].items;
    const lambda = {
      kind: 'list',
      items: [
        { kind: 'id', name: 'lambda', sym: head.sym, loc: head.loc },
        { kind: 'list', items: binds.map((b) => b.items[0]) },
        ...items.slice(2),
      ],
    };
    return { kind: 'list', items: [lambda, ...binds.map((b) => b.items[1])] };
  }
  return { kind: 'list', items };
}

// 身份短标签：按规范化输出中首次出现顺序稳定分配 a,b,c...
function assignLabels(tree) {
  const order = [];
  const index = new Map();
  (function walk(n) {
    if (n.kind === 'id') {
      const s = n.sym;
      if (s.origin !== 'core' && !index.has(s.id)) { index.set(s.id, order.length); order.push(s); }
    } else if (n.kind === 'list') n.items.forEach(walk);
  })(tree);
  const tagOf = (i) => {
    let s = '';
    i += 1;
    while (i > 0) { s = String.fromCharCode(97 + (i - 1) % 26) + s; i = Math.floor((i - 1) / 26); }
    return s;
  };
  const byId = new Map(order.map((s, i) => [s.id, tagOf(i)]));
  const legend = order.map((s) => ({
    tag: byId.get(s.id),
    name: s.name,
    origin: describeOrigin(s),
    loc: s.loc || null,
  }));
  return { byId, legend };
}

function describeOrigin(s) {
  switch (s.origin) {
    case 'lambda': return '调用点绑定（源 λ 引入）';
    case 'let': return '调用点绑定（源 let 引入）';
    case 'template': return `模板新作用域（宏 ${s.macro ?? '?'} 第 ${s.rule ?? '?'} 条规则引入）`;
    case 'macro': return '宏名';
    case 'free': return '顶层自由量（模块作用域，非局部绑定）';
    default: return String(s.origin);
  }
}

function printExpanded(node, labels) {
  if (node.kind === 'lit') return node.value;
  if (node.kind === 'id') {
    if (node.sym.origin === 'core') return node.name === 'λ' ? 'lambda' : node.name;
    return `${node.name}#${labels.byId.get(node.sym.id)}`;
  }
  return '(' + node.items.map((i) => printExpanded(i, labels)).join(' ') + ')';
}

// ---------------------------------------------------------------------------
// 展开驱动
// ---------------------------------------------------------------------------
function stripPatternHead(pat, macro) {
  if (!isList(pat)) {
    throw new ReviewError('BAD_MACRO', `宏 ${macro.name} 的规则模式必须是列表 (${macro.name} ...)`, locOf(pat));
  }
  const h = pat.items[0];
  if (!h || h.kind !== 'id' || (h.name !== macro.name && h.name !== '_')) {
    throw new ReviewError(
      'BAD_MACRO',
      `宏 ${macro.name} 的规则模式必须以宏名 ${macro.name} 或通配符 _ 开头`,
      locOf(h) || locOf(pat),
    );
  }
  return { kind: 'list', items: pat.items.slice(1), loc: pat.loc };
}

function expand(node, trace, ctx) {
  if (node.kind !== 'list') return node;
  const head = node.items[0];

  if (head && head.kind === 'id' && head.sym.origin === 'macro') {
    const macro = ctx.macroByName.get(head.name);
    if (ctx.depth >= ctx.maxDepth) {
      throw new ReviewError(
        'RECURSION_LIMIT',
        `宏展开嵌套深度超过上限 ${ctx.maxDepth}（宏 ${macro?.name ?? head.name}）`,
        locOf(head),
        [
          `调用链尾部：${trace.slice(-8).map((t) => `${t.macro}#规则${t.rule}`).join(' -> ') || macro?.name || head.name}`,
          '该错误仅作用于当前形式；服务无状态，后续合法模块/形式复核不受阻塞',
        ],
      );
    }
    const args = node.items.slice(1);
    let matched = null;
    const ruleFailures = [];
    macro.rules.forEach((rule, idx) => {
      if (matched) return;
      const pv = new Map();
      const reasons = [];
      if (matchPattern(rule.patArgs, { kind: 'list', items: args, loc: node.loc }, pv, macro.literalSyms, reasons)) {
        matched = { idx, rule, pv };
      } else {
        ruleFailures.push({ rule: idx + 1, reasons });
      }
    });
    if (!matched) {
      throw new ReviewError(
        'NO_MATCHING_RULE',
        `宏 ${macro.name} 没有可匹配的规则`,
        locOf(head),
        ruleFailures.map((f) => `规则${f.rule}：${f.reasons.join('；') || '形式不符'}`),
      );
    }
    ctx.bump();
    trace.push({
      macro: macro.name,
      rule: matched.idx + 1,
      ruleText: matched.rule.ruleText,
      callLoc: locOf(head),
      callSiteKind: head.fromTemplate ? '宏模板内嵌套调用（位置在宏定义模板）' : '模块调用点（位置在模块表达式）',
      depth: ctx.depth + 1,
    });
    const produced = instantiateForm(matched.rule.tpl, matched.pv, new Map(), {
      defEnv: ctx.defEnv, macro: macro.name, rule: matched.idx + 1,
    });
    return expand(produced, trace, { ...ctx, depth: ctx.depth + 1 });
  }
  return { kind: 'list', items: node.items.map((it) => expand(it, trace, ctx)), loc: node.loc };
}

function printRule(pat, tpl) {
  return `(${printRaw(pat)}  =>  ${printRaw(tpl)})`;
}
function printRaw(node) {
  if (node.kind === 'list') return '(' + node.items.map(printRaw).join(' ') + ')';
  return node.kind === 'id' ? node.name : node.value;
}

// ---------------------------------------------------------------------------
// analyze：输入已抽取的宏定义与表达式形式
// ---------------------------------------------------------------------------
export function analyze(defs, expressionForms, src, options = {}) {
  resetIdentityCounter();
  const maxDepth = options.maxDepth ?? 64;
  const maxApplications = options.maxApplications ?? 512;

  if (defs.length > 12) {
    throw new ReviewError('TOO_MANY_MACROS', '模块最多包含 12 个宏', locOf(defs[12].nameNode),
      [`实际宏数量：${defs.length}`]);
  }
  const macros = defs.map((d) => ({
    name: d.name,
    symRef: sym(d.name, 'macro', { loc: locOf(d.nameNode) }),
    rules: d.rules,
    literalIds: d.literalIds,
  }));
  const defEnv = buildDefinitionEnv(macros);
  const macroByName = new Map(macros.map((m) => [m.name, m]));

  for (const m of macros) {
    if (m.rules.length > 8) {
      throw new ReviewError('TOO_MANY_RULES', `宏 ${m.name} 最多包含 8 条规则`, locOf(m.rules[8].node),
        [`实际规则数：${m.rules.length}`]);
    }
    const literalSyms = new Map();
    for (const lit of m.literalIds) {
      if (!defEnv.isBound(lit.name)) {
        throw new ReviewError(
          'UNBOUND_LITERAL',
          `宏 ${m.name} 声明的 literal ${lit.name} 没有词法绑定（非核心关键字，也不是本模块已定义宏）`,
          locOf(lit.node),
          ['literal 必须在定义处词法环境中可解析，按绑定身份而非拼写匹配'],
        );
      }
      literalSyms.set(lit.name, defEnv.symOf(lit.name));
    }
    m.literalSyms = literalSyms;
    const literalNameSet = new Set(m.literalIds.map((l) => l.name));

    for (const rule of m.rules) {
      rule.patArgs = stripPatternHead(rule.pat, m);
      const state = { bound: new Map() };
      collectPatternVars(rule.patArgs, literalNameSet, state);
      checkTemplate(rule.tpl, state.bound, m.name);
      rule.boundVars = state.bound;
      rule.ruleText = printRule(rule.pat, rule.tpl);
    }
  }

  // 各顶层表达式相互隔离：单个形式失败（含递归超限）不阻塞其余形式
  const forms = expressionForms.map((form) => {
    const trace = [];
    try {
      const resolved = resolveExpression(form, new Map(), defEnv);
      let applications = 0;
      const expanded = expand(resolved, trace, {
        defEnv, macroByName, depth: 0, maxDepth, maxApplications,
        bump() {
          applications++;
          if (applications > maxApplications) {
            throw new ReviewError(
              'RECURSION_LIMIT',
              `宏展开应用次数超过上限 ${maxApplications}（疑似无限递归）`,
              trace[trace.length - 1]?.callLoc ?? null,
              ['应用次数为稳定证据；服务无状态，不影响后续复核'],
            );
          }
        },
      });
      const normalized = desugarLet(expanded);
      const labels = assignLabels(normalized);
      return {
        ok: true,
        sourceLoc: locOf(form),
        snippet: sourceSnippet(src, form.open ?? form.loc.offset),
        normalizedText: printExpanded(normalized, labels),
        identities: labels.legend,
        trace: trace.map((t) => ({
          macro: t.macro,
          rule: t.rule,
          ruleText: t.ruleText,
          callSiteKind: t.callSiteKind,
          callLoc: t.callLoc,
          callSnippet: sourceSnippet(src, t.callLoc.offset),
          depth: t.depth,
        })),
      };
    } catch (e) {
      const err = e instanceof ReviewError ? e
        : new ReviewError('INTERNAL', String(e?.message || e), locOf(form));
      return {
        ok: false,
        sourceLoc: locOf(form),
        snippet: sourceSnippet(src, form.open ?? form.loc.offset),
        error: {
          code: err.code,
          message: err.message,
          evidence: err.evidence || [],
          loc: err.loc,
          snippet: err.loc ? sourceSnippet(src, err.loc.offset) : null,
        },
      };
    }
  });

  return { macros: macros.map((m) => m.name), forms };
}
