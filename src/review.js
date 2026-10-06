'use strict';
// 复核入口：解析受限模块、抽取 define-syntax 定义、委托展开器。
//
// 模块形态：
//   (define-syntax <名>
//     (syntax-rules (<literal> ...)
//       (<模式> <模板>) ...))
//   <顶层表达式> ...                 ; 被复核的调用点
//
// 任何错误都返回结构化结论（含首个相关源片段与稳定证据），不抛出到 HTTP 层。

import { parse, isList, sourceSnippet } from './parser.js';
import { analyze, ReviewError } from './expander.js';

function locOf(node) {
  if (!node) return null;
  if (node.kind === 'list') return { offset: node.open, end: node.close };
  return { offset: node.loc.offset, end: node.loc.end };
}

// 抽取并校验一条 define-syntax
function extractDefinition(form) {
  const nameNode = form.items[1];
  if (!nameNode || nameNode.kind !== 'id') {
    throw new ReviewError('BAD_SYNTAX', 'define-syntax 需要宏名：(define-syntax <名> (syntax-rules ...))',
      locOf(nameNode) || locOf(form));
  }
  const srNode = form.items[2];
  if (!isList(srNode, 'syntax-rules')) {
    throw new ReviewError('BAD_SYNTAX',
      `宏 ${nameNode.name} 的变换体必须是 (syntax-rules (<literal> ...) (<规则>) ...)`,
      locOf(srNode) || locOf(form));
  }
  if (form.items.length !== 3) {
    const extra = form.items[3];
    throw new ReviewError('BAD_SYNTAX', `宏 ${nameNode.name} 的 define-syntax 含有多余形式`, locOf(extra));
  }
  const litList = srNode.items[1];
  if (!isList(litList)) {
    throw new ReviewError('BAD_SYNTAX',
      `宏 ${nameNode.name} 的 syntax-rules 需要 literal 表（可为空表 ()）`,
      locOf(litList) || locOf(srNode));
  }
  const literalIds = [];
  for (const lit of litList.items) {
    if (lit.kind !== 'id') {
      throw new ReviewError('BAD_SYNTAX', `宏 ${nameNode.name} 的 literal 必须是标识符`, locOf(lit));
    }
    literalIds.push({ name: lit.name, node: lit });
  }
  const rules = [];
  for (const r of srNode.items.slice(2)) {
    if (!isList(r) || r.items.length !== 2) {
      throw new ReviewError('BAD_SYNTAX',
        `宏 ${nameNode.name} 的每条规则必须恰好包含模式与模板两个形式`,
        locOf(r) || locOf(srNode));
    }
    rules.push({ pat: r.items[0], tpl: r.items[1], node: r });
  }
  if (rules.length === 0) {
    throw new ReviewError('BAD_SYNTAX', `宏 ${nameNode.name} 至少需要一条 syntax-rules 规则`, locOf(srNode));
  }
  return { name: nameNode.name, nameNode, literalIds, rules, defNode: form };
}

export function reviewSource(src, options = {}) {
  let forms;
  try {
    forms = parse(src);
  } catch (e) {
    const offset = Number.isInteger(e.offset) ? e.offset : 0;
    return {
      ok: false,
      stage: 'parse',
      error: {
        code: 'PARSE_ERROR',
        message: e.message,
        loc: { offset },
        snippet: sourceSnippet(src, offset),
        evidence: ['词法/语法分析在首个不完整片段处停止，未产生任何展开结论'],
      },
    };
  }

  if (forms.length === 0) {
    return {
      ok: false,
      stage: 'module',
      error: {
        code: 'EMPTY_MODULE',
        message: '模块为空：至少需要一个表达式形式（宏定义之外）',
        loc: null,
        snippet: null,
        evidence: [],
      },
    };
  }

  const defs = [];
  const exprs = [];
  const seenNames = new Map();
  try {
    for (const form of forms) {
      if (isList(form, 'define-syntax')) {
        const d = extractDefinition(form);
        if (seenNames.has(d.name)) {
          throw new ReviewError('BAD_SYNTAX', `宏 ${d.name} 重复定义`, locOf(d.nameNode),
            [`首次定义于偏移 ${seenNames.get(d.name)}`]);
        }
        seenNames.set(d.name, d.nameNode.loc.offset);
        defs.push(d);
      } else if (form.kind === 'list' && form.items[0]?.kind === 'id'
        && ['lambda', 'λ', 'let'].includes(form.items[0].name) === false) {
        exprs.push(form);
      } else if (form.kind === 'list') {
        exprs.push(form);
      } else {
        throw new ReviewError('BAD_SYNTAX', '模块顶层只允许宏定义或表达式形式（裸标识符不构成可复核调用）',
          locOf(form));
      }
    }
    const result = analyze(defs, exprs, src, options);
    return { ok: true, ...result };
  } catch (e) {
    const err = e instanceof ReviewError ? e : new ReviewError('INTERNAL', String(e?.message || e), null);
    return {
      ok: false,
      stage: 'module',
      error: {
        code: err.code,
        message: err.message,
        evidence: err.evidence || [],
        loc: err.loc,
        snippet: err.loc ? sourceSnippet(src, err.loc.offset) : null,
      },
    };
  }
}
