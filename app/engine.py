"""Hygienic one-level syntax-rules expander.

Identity model (Dybvig-Hieb marks, presented as idempotent scope sets):

* Every identifier is a ``(name, scopes)`` pair; scope 0 is the global one.
* A ``define-syntax`` adds a unique *introduction scope* to the whole
  ``syntax-rules`` spec, so identifiers appearing in a template carry that
  scope and can never be mark-identical to a call-site identifier.
* Every macro use adds a fresh *use scope* to the input form before pattern
  matching and removes it from the expansion output; pattern variables thus
  keep exactly the call-site binding identity, while template identifiers
  never acquire the use scope.
* Two identifiers are the same binding iff name **and** scope set are equal.
  Lexical binding is resolved on the marked output with an ordinary
  nearest-enclosing-binder walk, so template temporaries and call-site
  identifiers that merely share a spelling are provably distinct.

The engine is stateless across reviews: a failing review (including a
recursion-limit failure) cannot contaminate a later module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha1
from typing import Any, Dict, List, Optional, Set, Tuple

from .syntax import Cell, Form, GLOBAL_SCOPE, Sym, SyntaxError_, get_span

MAX_MACROS = 12
MAX_RULES = 8
EXPANSION_LIMIT = 64

CORE_FORMS = {"lambda", "let", "quote", "quasiquote", "define-syntax", "syntax-rules",
              "if", "cond", "begin", "and", "or", "else", "=>"}
BUILTIN_GLOBALS = {
    "+", "-", "*", "/", "=", "<", ">", "<=", ">=", "not",
    "cons", "car", "cdr", "list", "null?", "pair?", "eq?", "equal?",
    "display", "newline",
}

Identity = Tuple[str, frozenset]


def ident(sym: Sym) -> Identity:
    return (sym.name, sym.scopes)


class MacroError(Exception):
    def __init__(self, kind: str, message: str, span: Optional[Tuple[int, int]] = None,
                 evidence: Optional[str] = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.span = span
        self.evidence = evidence or _evidence(kind, message, span)


def _evidence(kind: str, message: str, span: Any) -> str:
    return "EV-" + sha1(f"{kind}|{message}|{span}".encode()).hexdigest()[:10]


# --------------------------------------------------------------------------- #
# Scope set helpers
# --------------------------------------------------------------------------- #

class ScopeSupply:
    def __init__(self) -> None:
        self.n = 0
        self.intro_scopes: Set[int] = set()

    def fresh(self) -> int:
        self.n += 1
        return self.n

    def fresh_intro(self) -> int:
        s = self.fresh()
        self.intro_scopes.add(s)
        return s


def add_scope(form: Form, scope: int) -> Form:
    if isinstance(form, Sym):
        return Sym(form.name, form.scopes | {scope}, form.span)
    if isinstance(form, Cell):
        return Cell([add_scope(x, scope) for x in form], span=form.span)
    return form


def remove_scope(form: Form, scope: int) -> Form:
    if isinstance(form, Sym):
        return Sym(form.name, form.scopes - {scope}, form.span) if scope in form.scopes else form
    if isinstance(form, Cell):
        return Cell([remove_scope(x, scope) for x in form], span=form.span)
    return form


# --------------------------------------------------------------------------- #
# Compiled syntax-rules
# --------------------------------------------------------------------------- #

PVar = Tuple[str, str]
PWild = Tuple[str]
PLit = Tuple[str, Sym]
PAtom = Tuple[str, Any]
PKeyword = Tuple[str, str]
PSeq = Tuple[str, List[Any], Optional[int]]

TSub = Tuple[str, str]
TIntro = Tuple[str, Sym]
TConst = Tuple[str, Any]
TSeq = Tuple[str, List[Any], Optional[Tuple[int, Cell]], Optional[Tuple[int, int]]]


@dataclass
class Rule:
    pattern: Form
    template: Form
    pcode: Any
    tcode: Any
    pvars: Set[str]
    repeated: Set[str]
    span: Optional[Tuple[int, int]]
    index: int


@dataclass
class Macro:
    name: str
    literals: List[Sym]
    rules: List[Rule]
    intro: int
    span: Optional[Tuple[int, int]]


def as_sym(f: Form) -> Optional[Sym]:
    return f if isinstance(f, Sym) else None


def _vars_under(node: Any) -> Set[str]:
    kind = node[0]
    if kind == "var":
        return {node[1]}
    if kind == "seq":
        out: Set[str] = set()
        for c in node[1]:
            out |= _vars_under(c)
        return out
    return set()


def compile_pattern(p: Form, literal_names: Set[str], pvars: Set[str],
                    repeated: Set[str], inside_rep: bool) -> Any:
    s = as_sym(p)
    if s is not None:
        if s.name == "...":
            raise MacroError("incomplete-syntax", "符号 '...' 缺少可重复的前导模式", s.span)
        if s.name == "_":
            return ("wild",)
        if s.name in literal_names:
            return ("lit", s)
        if s.name in pvars:
            raise MacroError("incomplete-syntax",
                             f"模式变量 '{s.name}' 在同一条规则中重复出现", s.span)
        pvars.add(s.name)
        return ("var", s.name)
    if not isinstance(p, Cell):
        return ("atom", p)
    items = list(p)
    marker = _find_marker(items, inside_rep, "模式")
    coded: List[Any] = []
    for i, item in enumerate(items):
        if marker is not None and i == marker:
            continue
        child_inside = inside_rep or (marker is not None and i == marker - 1)
        child = compile_pattern(item, literal_names, pvars, repeated, child_inside)
        coded.append(child)
        if marker is not None and i == marker - 1:
            repeated.update(_vars_under(child))
    ell_index = marker - 1 if marker is not None else None
    return ("seq", coded, ell_index)


def _find_marker(items: List[Form], inside_rep: bool, what: str) -> Optional[int]:
    marker: Optional[int] = None
    for i, it in enumerate(items):
        si = as_sym(it)
        if si is not None and si.name == "...":
            if i == 0:
                raise MacroError("incomplete-syntax", f"符号 '...' 缺少可重复的前导{what}", si.span)
            if marker is not None:
                raise MacroError("incomplete-syntax", f"每层只允许一个 '...'", si.span)
            if inside_rep:
                raise MacroError("incomplete-syntax", "只允许一层重复，'...' 不能嵌套", si.span)
            marker = i
    return marker


def compile_template(t: Form, pvars: Set[str], repeated: Set[str],
                     inside_rep: bool) -> Any:
    s = as_sym(t)
    if s is not None:
        if s.name == "...":
            raise MacroError("incomplete-syntax", "符号 '...' 缺少可重复的前导模板", s.span)
        if s.name in pvars:
            if s.name in repeated and not inside_rep:
                raise MacroError(
                    "incomplete-syntax",
                    f"重复模式变量 '{s.name}' 只能在模板的 '...' 片段中使用", s.span)
            return ("sub", s.name)
        return ("intro", s)
    if not isinstance(t, Cell):
        return ("const", t)
    items = list(t)
    marker = _find_marker(items, inside_rep, "模板")
    coded: List[Any] = []
    for i, item in enumerate(items):
        if marker is not None and i == marker:
            continue
        child_inside = inside_rep or (marker is not None and i == marker - 1)
        coded.append(compile_template(item, pvars, repeated, child_inside))
    rep: Optional[Tuple[int, Cell]] = None
    if marker is not None:
        idx = marker - 1
        rep_cell = items[marker - 1]
        refs = _subs_under(coded[idx])
        if not (refs & repeated):
            raise MacroError("incomplete-syntax",
                             "模板重复片段必须引用至少一个重复模式变量",
                             get_span(items[marker]))
        rep = (idx, rep_cell)
    return ("seq", coded, rep, t.span)


def _subs_under(node: Any) -> Set[str]:
    kind = node[0]
    if kind == "sub":
        return {node[1]}
    if kind == "seq":
        out: Set[str] = set()
        for c in node[1]:
            out |= _subs_under(c)
        return out
    return set()


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #

# Local binding environment entry: (name, lexical-scope-set, binder key).
# Resolution is subset-based (a reference sees every enclosing binder whose
# lexical scopes it carries, nearest/largest wins).  Macro introduction and
# use scopes therefore never create or shadow lexical bindings.
Env = List[Tuple[str, frozenset, Any]]


def resolve_binding(sym: Sym, env: Env) -> Tuple[str, Any]:
    best: Optional[Tuple[frozenset, Any]] = None
    for name, scopes, key in env:
        if name == sym.name and scopes <= sym.scopes:
            if best is None or len(scopes) > len(best[0]):
                best = (scopes, key)
    if best is not None:
        return ("local", best[1])
    return ("global", sym.name)


def _same_form(a: Form, b: Form) -> bool:
    if isinstance(a, Sym) and isinstance(b, Sym):
        return ident(a) == ident(b)
    if isinstance(a, Cell) and isinstance(b, Cell):
        return len(a) == len(b) and all(_same_form(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def match(node: Any, form: Form, env: Env, binds: Dict[str, Form],
          def_bind: Dict[str, Tuple[str, Any]]) -> bool:
    kind = node[0]
    if kind == "wild":
        return True
    if kind == "var":
        name = node[1]
        if name in binds:
            return _same_form(binds[name], form)
        binds[name] = form
        return True
    if kind == "atom":
        return not isinstance(form, (Sym, Cell)) and type(form) is type(node[1]) and form == node[1]
    if kind == "keyword":
        f = as_sym(form)
        if f is None or f.name != node[1]:
            return False
        # The keyword must resolve to this macro's global binding, not to a
        # local identifier that merely shares the spelling.
        rb = resolve_binding(f, env)
        return rb == ("global", node[1])
    if kind == "lit":
        f = as_sym(form)
        if f is None:
            return False
        return resolve_binding(f, env) == def_bind[node[1].name]
    # seq ---------------------------------------------------------------
    if not isinstance(form, Cell):
        return False
    seq_items: List[Any] = node[1]
    ell: Optional[int] = node[2]
    if ell is None:
        if len(form) != len(seq_items):
            return False
        return all(match(c, x, env, binds, def_bind) for c, x in zip(seq_items, form))
    fixed_before = ell
    fixed_after = len(seq_items) - ell - 1
    if len(form) < fixed_before + fixed_after:
        return False
    for c, x in zip(seq_items[:fixed_before], form[:fixed_before]):
        if not match(c, x, env, binds, def_bind):
            return False
    rep_count = len(form) - fixed_before - fixed_after
    rep_child = seq_items[fixed_before]
    rep_vars = _vars_under(rep_child)
    lists: Dict[str, List[Form]] = {v: [] for v in rep_vars}
    rep_inputs = form[fixed_before:fixed_before + rep_count]
    for x in rep_inputs:
        iteration: Dict[str, Form] = {}
        if not match(rep_child, x, env, iteration, def_bind):
            return False
        for v in rep_vars:
            if v not in iteration:
                return False
            lists[v].append(iteration[v])
    tail_items = seq_items[fixed_before + 1:]
    tail_inputs = form[fixed_before + rep_count:]
    if not all(match(c, x, env, binds, def_bind)
               for c, x in zip(tail_items, tail_inputs)):
        return False
    binds.update(lists)  # type: ignore[arg-type]
    return True


# --------------------------------------------------------------------------- #
# Template instantiation
# --------------------------------------------------------------------------- #

def _is_replist(v: Any) -> bool:
    """True only for repetition accumulators (plain lists), never Cell forms."""
    return type(v) is list


def instantiate(node: Any, binds: Dict[str, Form], rep_cell: Optional[Cell] = None,
                frame: Optional[int] = None) -> Form:
    kind = node[0]
    if kind == "sub":
        v = binds[node[1]]
        if _is_replist(v):
            if frame is None:
                raise MacroError("incomplete-syntax",
                                 f"重复变量 '{node[1]}' 用在了重复片段之外", None)
            return v[frame]
        return v
    if kind == "intro":
        return node[1]
    if kind == "const":
        return node[1]
    coded: List[Any] = node[1]
    rep: Optional[Tuple[int, Cell]] = node[2]
    span: Optional[Tuple[int, int]] = node[3]
    if rep is None:
        return Cell([instantiate(c, binds, None, frame) for c in coded], span=span)
    idx, rep_tmpl_cell = rep
    rep_node = coded[idx]
    rep_vars = _subs_under(rep_node)
    lengths = {len(binds[n]) for n in rep_vars if _is_replist(binds.get(n))}
    if len(lengths) > 1:
        detail = ", ".join(f"{n}={len(binds[n])}"
                           for n in sorted(rep_vars) if _is_replist(binds.get(n)))
        raise MacroError("repetition-mismatch",
                         f"重复变量长度不一致（{detail}），模板片段要求等长",
                         rep_tmpl_cell.span)
    count = next(iter(lengths)) if lengths else 0
    out: List[Form] = [instantiate(c, binds, None, frame) for c in coded[:idx]]
    for i in range(count):
        out.append(instantiate(rep_node, binds, rep_tmpl_cell, i))
    out.extend(instantiate(c, binds, None, frame) for c in coded[idx + 1:])
    return Cell(out, span=span)


# --------------------------------------------------------------------------- #
# Step records
# --------------------------------------------------------------------------- #

@dataclass
class Step:
    step_id: str
    macro: str
    rule_index: int
    rule_pattern: str
    rule_template: str
    call_span: Tuple[int, int]
    call_line: int
    call_column: int
    call_origin: str
    intro_scope: str
    use_scope: str
    before: str
    after: str
    origins: List[Dict[str, Any]]


@dataclass
class ReviewResult:
    ok: bool
    error: Optional[Dict[str, Any]] = None
    steps: List[Step] = field(default_factory=list)
    normalized: str = ""
    identities: List[Dict[str, Any]] = field(default_factory=list)
    hygiene_checks: List[Dict[str, Any]] = field(default_factory=list)
    macro_count: int = 0


def locate(src: str, span: Optional[Tuple[int, int]]) -> Tuple[int, int, str]:
    if span is None:
        return 0, 0, ""
    start, end = span
    line = src.count("\n", 0, start) + 1
    line_start = src.rfind("\n", 0, start) + 1
    col = start - line_start + 1
    line_end = src.find("\n", end)
    if line_end == -1:
        line_end = len(src)
    text = src[line_start:line_end]
    caret = " " * (start - line_start) + "^" + "~" * max(0, end - start - 1)
    return line, col, f"{text}\n{caret}"


def _error_payload(kind: str, message: str, span: Any, evidence: str, src: str) -> Dict[str, Any]:
    line, col, snippet = locate(src, span)
    return {"kind": kind, "message": message, "evidence": evidence,
            "line": line, "column": col, "snippet": snippet,
            "span": list(span) if span else None}


# --------------------------------------------------------------------------- #
# Review driver
# --------------------------------------------------------------------------- #

def review(src: str) -> ReviewResult:
    from .syntax import parse_module
    res = ReviewResult(ok=False)
    try:
        forms = parse_module(src)
        macros: Dict[str, Macro] = {}
        bodies: List[Form] = []
        scopes = ScopeSupply()
        for f in forms:
            if (isinstance(f, Cell) and f and isinstance(f[0], Sym)
                    and f[0].name == "define-syntax"):
                _compile_macro(f, macros, scopes)
            else:
                bodies.append(f)
        res.macro_count = len(macros)

        env: Env = []
        step_counter = [0]
        expanded = [_expand(f, env, 1, macros, scopes, res, step_counter, src)
                    for f in bodies]

        norm, identities, checks = _annotate(expanded, scopes.intro_scopes, src)
        res.normalized = norm
        res.identities = identities
        res.hygiene_checks = checks
        res.ok = True
        return res
    except MacroError as e:
        res.error = _error_payload(e.kind, e.message, e.span, e.evidence, src)
        return res
    except SyntaxError_ as e:
        ev = _evidence("incomplete-syntax", e.message, e.span)
        res.error = _error_payload("incomplete-syntax", e.message, e.span, ev, src)
        return res


# --------------------------------------------------------------------------- #
# Macro compilation
# --------------------------------------------------------------------------- #

def _compile_macro(f: Cell, macros: Dict[str, Macro], scopes: ScopeSupply) -> None:
    if len(f) != 3 or not isinstance(f[1], Sym):
        raise MacroError("incomplete-syntax",
                         "define-syntax 形式应为 (define-syntax <名称> (syntax-rules ...))",
                         f.span)
    name_sym: Sym = f[1]
    spec = f[2]
    if (not isinstance(spec, Cell) or not spec or not isinstance(spec[0], Sym)
            or spec[0].name != "syntax-rules"):
        raise MacroError("incomplete-syntax",
                         "宏体必须是 (syntax-rules (<literal>...) (<模式> <模板>) ...)",
                         get_span(spec))
    if name_sym.name in macros:
        raise MacroError("incomplete-syntax", f"宏 '{name_sym.name}' 重复定义", name_sym.span)
    if len(macros) >= MAX_MACROS:
        raise MacroError("incomplete-syntax", f"模块最多包含 {MAX_MACROS} 个宏", f.span)
    if len(spec) < 2 or not isinstance(spec[1], Cell):
        raise MacroError("incomplete-syntax", "syntax-rules 需要 literal 列表", spec.span)
    literal_syms = [l for l in spec[1]]
    for l in literal_syms:
        if not isinstance(l, Sym):
            raise MacroError("incomplete-syntax", "literal 必须是标识符", get_span(l))
    rules_src = spec[2:]
    if not rules_src:
        raise MacroError("incomplete-syntax", "syntax-rules 至少需要一条规则", spec.span)
    if len(rules_src) > MAX_RULES:
        raise MacroError("incomplete-syntax", f"每个宏最多 {MAX_RULES} 条规则",
                         get_span(rules_src[MAX_RULES]))

    # Definition-site lexical environment: core keywords, builtins and the
    # names of macros defined earlier in the module are all valid literals.
    bound_at_def = CORE_FORMS | BUILTIN_GLOBALS | set(macros)
    for l in literal_syms:
        if l.name not in bound_at_def:
            raise MacroError("unbound-literal",
                             f"literal '{l.name}' 在宏定义处没有词法绑定", l.span)

    intro = scopes.fresh_intro()
    marked_spec = add_scope(spec, intro)
    assert isinstance(marked_spec, Cell)
    literal_names = {l.name for l in literal_syms}
    rules: List[Rule] = []
    for i, rsrc in enumerate(marked_spec[2:]):
        if not isinstance(rsrc, Cell) or len(rsrc) != 2:
            raise MacroError("incomplete-syntax", "规则必须是 (<模式> <模板>)", get_span(rsrc))
        pattern, template = rsrc[0], rsrc[1]
        if not isinstance(pattern, Cell) or not pattern:
            raise MacroError("incomplete-syntax", "规则模式必须是列表形式", get_span(pattern))
        pvars: Set[str] = set()
        repeated: Set[str] = set()
        pcode = compile_pattern(pattern, literal_names, pvars, repeated, False)
        head = pcode[1][0]
        if head[0] == "var" and head[1] != name_sym.name:
            raise MacroError("incomplete-syntax",
                             f"规则模式首项必须是宏名 '{name_sym.name}' 或下划线 '_'",
                             get_span(pattern[0]))
        if head[0] not in ("var", "lit", "wild"):
            raise MacroError("incomplete-syntax", "规则模式必须以宏关键字或通配符开头",
                             get_span(pattern[0]) if isinstance(pattern, Cell) else None)
        # The leading pattern position is the macro keyword, not a variable.
        if head[0] == "var":
            pvars.discard(name_sym.name)
        pcode[1][0] = ("keyword", name_sym.name)
        tcode = compile_template(template, pvars, repeated, False)
        rules.append(Rule(pattern, template, pcode, tcode, pvars, repeated,
                          get_span(rsrc), i))

    macros[name_sym.name] = Macro(name_sym.name, list(marked_spec[1]), rules, intro, f.span)


# --------------------------------------------------------------------------- #
# Core expander
# --------------------------------------------------------------------------- #

def _expand(form: Form, env: Env, depth: int, macros: Dict[str, Macro],
            scopes: ScopeSupply, res: ReviewResult, step_counter: List[int],
            src: str, root_span: Optional[Tuple[int, int]] = None) -> Form:
    if not isinstance(form, Cell) or not form:
        return form
    head = form[0]
    if isinstance(head, Sym):
        if head.name in ("quote", "quasiquote"):
            return form
        if head.name == "lambda" and resolve_binding(head, env) == ("global", "lambda"):
            return _expand_lambda(form, env, depth, macros, scopes, res, step_counter, src)
        if head.name == "let" and resolve_binding(head, env) == ("global", "let"):
            return _expand_let(form, env, depth, macros, scopes, res, step_counter, src)
        rb = resolve_binding(head, env)
        if rb[0] == "global" and rb[1] in macros:
            return _expand_macro(form, env, depth, macros, scopes, res, step_counter, src,
                                 root_span)
    return Cell([_expand(x, env, depth, macros, scopes, res, step_counter, src, root_span)
                 for x in form], span=form.span)


def _check_params(params: Form) -> List[Sym]:
    if not isinstance(params, Cell):
        raise MacroError("incomplete-syntax", "lambda 参数必须是标识符列表", get_span(params))
    out = []
    for p in params:
        if not isinstance(p, Sym):
            raise MacroError("incomplete-syntax", "lambda 参数必须是标识符", get_span(p))
        out.append(p)
    return out


def _expand_lambda(form: Cell, env: Env, depth, macros, scopes, res, step_counter, src,
                   root_span=None):
    if len(form) < 3:
        raise MacroError("incomplete-syntax",
                         "lambda 形式应为 (lambda (<参数>...) <主体>...)", form.span)
    params = _check_params(form[1])
    scope = scopes.fresh()
    new_params = [Sym(p.name, p.scopes | {scope}, p.span) for p in params]
    if len({p.name for p in new_params}) != len(new_params):
        raise MacroError("incomplete-syntax", "lambda 参数名重复", form[1].span)
    new_env = env + [(p.name, ps.scopes, object()) for p, ps in zip(params, new_params)]
    bodies = [add_scope(b, scope) for b in form[2:]]
    bodies = [_expand(b, new_env, depth, macros, scopes, res, step_counter, src, root_span)
              for b in bodies]
    return Cell([Sym("lambda", form[0].scopes, form[0].span),
                 Cell(new_params, span=form[1].span)] + bodies, span=form.span)


def _expand_let(form: Cell, env: Env, depth, macros, scopes, res, step_counter, src,
                root_span=None):
    if len(form) < 3 or not isinstance(form[1], Cell):
        raise MacroError("incomplete-syntax",
                         "let 形式应为 (let ((<名称> <表达式>)...) <主体>...)", form.span)
    bind_cell = form[1]
    binders: List[Sym] = []
    new_pairs: List[Form] = []
    for pair in bind_cell:
        if not isinstance(pair, Cell) or len(pair) != 2 or not isinstance(pair[0], Sym):
            raise MacroError("incomplete-syntax",
                             "let 绑定必须是 (<名称> <表达式>)", get_span(pair))
        binders.append(pair[0])
        ival = _expand(pair[1], env, depth, macros, scopes, res, step_counter, src,
                       root_span)
        new_pairs.append(Cell([pair[0], ival], span=pair.span))
    scope = scopes.fresh()
    new_binders = [Sym(b.name, b.scopes | {scope}, b.span) for b in binders]
    if len({b.name for b in new_binders}) != len(new_binders):
        raise MacroError("incomplete-syntax", "let 绑定名重复", bind_cell.span)
    new_env = env + [(b.name, bs.scopes, object()) for b, bs in zip(binders, new_binders)]
    final_pairs = [Cell([bs, p[1]], span=p.span) for bs, p in zip(new_binders, new_pairs)]
    bodies = [add_scope(b, scope) for b in form[2:]]
    bodies = [_expand(b, new_env, depth, macros, scopes, res, step_counter, src, root_span)
              for b in bodies]
    return Cell([Sym("let", form[0].scopes, form[0].span),
                 Cell(final_pairs, span=bind_cell.span)] + bodies, span=form.span)


def _expand_macro(form: Cell, env: Env, depth, macros: Dict[str, Macro],
                  scopes: ScopeSupply, res: ReviewResult, step_counter, src: str,
                  root_span: Optional[Tuple[int, int]] = None) -> Form:
    root = root_span or form.span
    if depth > EXPANSION_LIMIT:
        raise MacroError("recursion-limit",
                         f"宏展开递归深度超过 {EXPANSION_LIMIT} 层，疑似无限递归", root)
    macro = macros[form[0].name]
    use = scopes.fresh()
    marked = add_scope(form, use)
    assert isinstance(marked, Cell)
    # Literal identities as resolved at the macro's definition environment.
    def_bind = {l.name: ("global", l.name) for l in macro.literals}
    binds: Dict[str, Form] = {}
    chosen: Optional[Rule] = None
    for rule in macro.rules:
        attempt: Dict[str, Form] = {}
        if match(rule.pcode, marked, env, attempt, def_bind):
            binds = attempt
            chosen = rule
            break
    if chosen is None:
        raise MacroError("no-rule-match",
                         f"宏 '{macro.name}' 的 {len(macro.rules)} 条规则均不匹配该调用",
                         form.span)
    output = instantiate(chosen.tcode, binds)
    output = remove_scope(output, use)
    if not isinstance(output, Cell):
        output = Cell([output])

    step_counter[0] += 1
    line, col, _ = locate(src, form.span)
    after_text, origins = _render_origin(output, macro.intro)
    call_origin = ("macro-template" if form[0].scopes & scopes.intro_scopes
                   else "call-site")
    res.steps.append(Step(
        step_id=f"ST-{step_counter[0]:04d}",
        macro=macro.name,
        rule_index=chosen.index + 1,
        rule_pattern=_render_plain(chosen.pattern),
        rule_template=_render_plain(chosen.template),
        call_span=form.span or (0, 0),
        call_line=line,
        call_column=col,
        call_origin=call_origin,
        intro_scope=f"M{macro.intro}",
        use_scope=f"U{use}",
        before=_render_plain(form),
        after=after_text,
        origins=origins,
    ))
    return _expand(output, env, depth + 1, macros, scopes, res, step_counter, src, root)


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

def _render_plain(f: Form) -> str:
    if isinstance(f, Sym):
        return f.name
    if isinstance(f, Cell):
        return "(" + " ".join(_render_plain(x) for x in f) + ")"
    if f is True:
        return "#t"
    if f is False:
        return "#f"
    if isinstance(f, str):
        return '"' + f.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return str(f)


def _render_origin(f: Form, intro: int) -> Tuple[str, List[Dict[str, Any]]]:
    """Tag every output identifier as template-introduced (T) or call-site (C)."""
    origins: List[Dict[str, Any]] = []

    def go(x: Form) -> str:
        if isinstance(x, Sym):
            from_template = intro in x.scopes
            tag = "template" if from_template else "call-site"
            origins.append({"name": x.name, "origin": tag,
                            "scopes": sorted(x.scopes)})
            return f"{x.name}⟨{'模' if from_template else '调'}⟩"
        if isinstance(x, Cell):
            return "(" + " ".join(go(y) for y in x) + ")"
        return _render_plain(x)

    return go(f), origins


# --------------------------------------------------------------------------- #
# Identity annotation of the fully normalized program
# --------------------------------------------------------------------------- #

def _annotate(program: List[Form], intro_scopes: Set[int], src: str):
    # binder-key -> tag
    key_tag: Dict[Identity, str] = {}
    binder_info: Dict[str, Dict[str, Any]] = {}
    counter = [0]

    def tag_for_binder(sym: Sym) -> str:
        # Every binding *occurrence* gets its own tag; reference identity is
        # established by lexical resolution with nearest-enclosing shadowing.
        counter[0] += 1
        t = f"B{counter[0]}"
        line, col, _ = locate(src, sym.span)
        binder_info[t] = {
            "tag": t, "name": sym.name, "kind": "binder",
            "origin": "macro-template" if (sym.scopes & intro_scopes) else "source",
            "line": line, "column": col,
            "scopes": sorted(sym.scopes),
        }
        return t

    free_tags: Dict[Identity, str] = {}
    free_info: Dict[str, Dict[str, Any]] = {}
    fcounter = [0]

    def tag_for_free(sym: Sym) -> str:
        key = ident(sym)
        if key not in free_tags:
            fcounter[0] += 1
            t = f"F{fcounter[0]}"
            free_tags[key] = t
            from_template = bool(sym.scopes & intro_scopes)
            if sym.scopes == frozenset({GLOBAL_SCOPE}):
                kind = "builtin" if sym.name in (
                    BUILTIN_GLOBALS | CORE_FORMS) else "free-global"
            else:
                kind = "macro-introduced-free" if from_template else "free"
            free_info[t] = {"tag": t, "name": sym.name, "kind": kind,
                            "origin": "macro-template" if from_template else "global",
                            "line": None, "column": None,
                            "scopes": sorted(sym.scopes)}
        return free_tags[key]

    def render(f: Form, env: Env) -> str:
        if isinstance(f, Sym):
            rb = resolve_binding(f, env)
            if rb[0] == "local":
                return f"{f.name}⁽{rb[1]}⁾"
            return f"{f.name}⁽{tag_for_free(f)}⁾"
        if isinstance(f, Cell) and f and isinstance(f[0], Sym) \
                and f[0].name in ("quote", "quasiquote"):
            return _render_plain(f)
        if isinstance(f, Cell) and f and isinstance(f[0], Sym) and f[0].name == "lambda":
            params = _check_params(f[1])
            keys = [tag_for_binder(p) for p in params]
            new_env = env + [(p.name, p.scopes, k)
                             for p, k in zip(params, keys)]
            body = " ".join(render(b, new_env) for b in f[2:])
            ps = " ".join(f"{p.name}⁽{k}⁾" for p, k in zip(params, keys))
            return f"(lambda ({ps}) {body})"
        if isinstance(f, Cell) and f and isinstance(f[0], Sym) and f[0].name == "let":
            if not isinstance(f[1], Cell):
                raise MacroError("incomplete-syntax", "let 绑定必须是列表",
                                 getattr(f[1], "span", None))
            binders: List[Sym] = []
            for pair in f[1]:
                if not isinstance(pair, Cell) or len(pair) != 2 or not isinstance(pair[0], Sym):
                    raise MacroError("incomplete-syntax",
                                     "let 绑定必须是 (<名称> <表达式>)", get_span(pair))
                binders.append(pair[0])
            keys = [tag_for_binder(b) for b in binders]
            new_env = env + [(b.name, b.scopes, k)
                             for b, k in zip(binders, keys)]
            pairs = " ".join(
                f"({b.name}⁽{k}⁾ {render(pair[1], env)})"
                for b, k, pair in zip(binders, keys, f[1]))
            body = " ".join(render(x, new_env) for x in f[2:])
            return f"(let ({pairs}) {body})"
        if isinstance(f, Cell):
            return "(" + " ".join(render(x, env) for x in f) + ")"
        return _render_plain(f)

    lines = [render(f, []) for f in program]
    identities = list(binder_info.values()) + list(free_info.values())

    # Hygiene verdicts.  The evidence the procedure page must make explicit:
    # a template-introduced binding and a source/call-site binding that share
    # a spelling are nevertheless different binding identities.
    by_name: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for info in binder_info.values():
        groups = by_name.setdefault(info["name"], {"macro-template": [], "source": []})
        groups[info["origin"]].append(info)
    checks: List[Dict[str, Any]] = []
    for name, groups in sorted(by_name.items()):
        if groups["macro-template"] and groups["source"]:
            t = [b["tag"] for b in groups["macro-template"]]
            s = [b["tag"] for b in groups["source"]]
            allb = groups["macro-template"] + groups["source"]
            checks.append({
                "name": name,
                "verdict": "distinct",
                "message": (
                    f"控制量 '{name}' 存在 {len(allb)} 个绑定身份：模板临时量 "
                    + "、".join(t) + " 与调用点绑定 " + "、".join(s)
                    + " 拼写相同，但标记作用域不相交；展开中两者引用各自独立解析，未发生捕获。"),
                "bindings": allb,
            })
    # Same story when the template leaves the same-named identifier free:
    # it resolves to its own (unbound/global) identity, not the local one.
    source_binder_names = {info["name"] for info in binder_info.values()
                           if info["origin"] == "source"}
    for info in free_info.values():
        if info["origin"] == "macro-template" and info["name"] in source_binder_names:
            checks.append({
                "name": info["name"],
                "verdict": "distinct",
                "message": (
                    f"模板中的自由标识符 '{info['name']}'（{info['tag']}，"
                    "解析到全局/宏定义处）与调用点同名局部绑定（"
                    + "、".join(b["tag"] for b in by_name[info["name"]]["source"])
                    + "）身份不同；literal 按词法绑定比较，未按拼写捕获。"),
                "bindings": [info] + by_name[info["name"]]["source"],
            })
    return "\n".join(lines), identities, checks
