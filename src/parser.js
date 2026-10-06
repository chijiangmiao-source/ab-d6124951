// 词法分析与 S 表达式解析。
// 每个原子记录首个字符在源码中的偏移（loc.offset），用于错误定位首个相关源片段。
'use strict';

export class ParseError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'ParseError';
    this.offset = offset;
  }
}

const PUNCT = new Set(['(', ')', '[', ']', '`']);

// 把源码切为 token：{ type: 'punc'|'id'|'number'|'string'|'boolean', value, offset, end }
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ';') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let buf = '"';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          buf += src[i] + src[i + 1];
          i += 2;
        } else {
          if (src[i] === '\n') throw new ParseError('字符串字面量不完整（缺少结束引号）', start);
          buf += src[i];
          i++;
        }
      }
      if (i >= n) throw new ParseError('字符串字面量不完整（缺少结束引号）', start);
      buf += '"';
      i++;
      tokens.push({ type: 'string', value: buf, offset: start, end: i });
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ type: 'punc', value: c, offset: i, end: i + 1 });
      i++;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    const start = i;
    let buf = '';
    while (i < n && !/[\s]/.test(src[i]) && !PUNCT.has(src[i]) && src[i] !== ';') {
      buf += src[i];
      i++;
    }
    let type = 'id';
    if (/^[+-]?\d+(\.\d+)?$/.test(buf)) type = 'number';
    else if (buf === '#t' || buf === '#f') type = 'boolean';
    tokens.push({ type, value: buf, offset: start, end: i });
  }
  return tokens;
}

// AST 节点：
//   { kind: 'list', items, open: offset, close: offset }
//   { kind: 'id', name, loc: {offset,end} }
//   { kind: 'lit', value, loc }
export function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;

  function parseList(openTok) {
    const items = [];
    const open = openTok.offset;
    pos++; // consume (
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.type === 'punc' && (t.value === ')' || t.value === ']')) {
        const close = t.offset;
        pos++;
        return { kind: 'list', items, open, close };
      }
      if (t.type === 'punc' && (t.value === '(' || t.value === '[')) {
        items.push(parseList(t));
      } else if (t.type === 'punc' && t.value === '`') {
        throw new ParseError('反引号不在支持范围内', t.offset);
      } else {
        pos++;
        items.push(atomOf(t));
      }
    }
    throw new ParseError('语法不完整：列表缺少右括号 )', open);
  }

  function atomOf(t) {
    if (t.type === 'id') return { kind: 'id', name: t.value, loc: { offset: t.offset, end: t.end } };
    return { kind: 'lit', value: t.value, loc: { offset: t.offset, end: t.end } };
  }

  const forms = [];
  while (pos < tokens.length) {
    const t = tokens[pos];
    if (t.type === 'punc' && (t.value === ')' || t.value === ']')) {
      throw new ParseError('语法不完整：遇到未配对的右括号 )', t.offset);
    }
    if (t.type === 'punc' && (t.value === '(' || t.value === '[')) {
      forms.push(parseList(t));
    } else if (t.type === 'punc' && t.value === '`') {
      throw new ParseError('反引号不在支持范围内', t.offset);
    } else {
      pos++;
      forms.push(atomOf(t));
    }
  }
  return forms;
}

export function idName(node) {
  return node && node.kind === 'id' ? node.name : null;
}

export function isList(node, head) {
  if (!node || node.kind !== 'list') return false;
  if (head === undefined) return true;
  const h = node.items[0];
  return !!h && h.kind === 'id' && h.name === head;
}

// 取 list 中某 head 之后的参数：(head a b c) -> [a,b,c]
export function argsOf(node) {
  return node.items.slice(1);
}

// 由 (name ...) 形态中按名字找子表，找不到返回 null
export function findForm(list, headName) {
  for (const it of list.items) {
    if (isList(it, headName)) return it;
  }
  return null;
}

// 稳定的源码片段（带行号列号），用于错误定位“首个相关源片段”
export function sourceSnippet(src, offset) {
  let line = 1;
  let col = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') { line++; col = 1; lineStart = i + 1; }
    else col++;
  }
  let lineEnd = src.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = src.length;
  const text = src.slice(lineStart, lineEnd);
  const caret = ' '.repeat(Math.max(0, col - 1)) + '^';
  return { line, column: col, text, caret, offset };
}
