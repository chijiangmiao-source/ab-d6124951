"""Marked s-expression reader.

Every identifier is a :class:`Sym` carrying a name, a set of expansion scopes
(the basis of hygienic alpha-equivalence) and a source span.

Lists are :class:`Cell` instances (a ``list`` subclass) carrying their own
span, so source locations survive deep copies made during macro expansion.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple


Span = Tuple[int, int]  # (start offset, end offset) in source text

# Scope id 0 is the global lexical environment shared by the whole module.
GLOBAL_SCOPE = 0


class Cell(list):
    """A list form with a source span."""

    span: Optional[Span]

    def __init__(self, items=(), span: Optional[Span] = None):
        super().__init__(items)
        self.span = span


@dataclass(frozen=True)
class Sym:
    name: str
    scopes: frozenset = frozenset({GLOBAL_SCOPE})
    span: Optional[Span] = None

    def label(self) -> str:
        tag = ".".join(str(s) for s in sorted(self.scopes))
        return f"{self.name}@[{tag}]"


Form = object


def get_span(f: Form) -> Optional[Span]:
    if isinstance(f, Sym):
        return f.span
    if isinstance(f, Cell):
        return f.span
    return None


class SyntaxError_(Exception):
    def __init__(self, message: str, span: Optional[Span] = None):
        super().__init__(message)
        self.message = message
        self.span = span


# --------------------------------------------------------------------------- #
# Tokenizer
# --------------------------------------------------------------------------- #

def _is_delim(ch: str) -> bool:
    return ch in '();`"\' \t\r\n'


def tokenize(src: str) -> List[Tuple[str, str, Span]]:
    toks: List[Tuple[str, str, Span]] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch == "\n":
            i += 1
            continue
        if ch in " \t\r":
            i += 1
            continue
        if ch == ";":
            while i < n and src[i] != "\n":
                i += 1
            continue
        start = i
        if ch in "()'`":
            toks.append((ch, ch, (start, start + 1)))
            i += 1
            continue
        if ch == '"':
            i += 1
            buf = []
            while i < n and src[i] != '"':
                if src[i] == "\\" and i + 1 < n:
                    esc = src[i + 1]
                    buf.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(esc, esc))
                    i += 2
                else:
                    buf.append(src[i])
                    i += 1
            if i >= n:
                raise SyntaxError_("unterminated string literal", (start, n))
            i += 1  # closing quote
            toks.append(("str", "".join(buf), (start, i)))
            continue
        buf = []
        while i < n and not _is_delim(src[i]):
            buf.append(src[i])
            i += 1
        toks.append(("atom", "".join(buf), (start, i)))
    toks.append(("eof", "", (n, n)))
    return toks


def _parse_atom(text: str, span: Span) -> Form:
    if text == "#t":
        return True
    if text == "#f":
        return False
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return Sym(text, span=span)


class Reader:
    def __init__(self, src: str):
        self.src = src
        self.toks = tokenize(src)
        self.pos = 0

    def peek(self):
        return self.toks[self.pos]

    def next(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    def read_all(self) -> List[Form]:
        forms = []
        while self.peek()[0] != "eof":
            forms.append(self.read_form())
        return forms

    def read_form(self) -> Form:
        kind, text, span = self.peek()
        if kind == "(":
            return self.read_list()
        if kind == ")":
            raise SyntaxError_("unexpected ')'", span)
        if kind == "'":
            self.next()
            inner = self.read_form()
            return Cell([Sym("quote", span=span), inner], span=(span[0], end_span(inner)))
        if kind == "`":
            self.next()
            inner = self.read_form()
            return Cell([Sym("quasiquote", span=span), inner], span=(span[0], end_span(inner)))
        if kind in ("atom", "str"):
            self.next()
            if kind == "str":
                return text
            return _parse_atom(text, span)
        raise SyntaxError_("incomplete input: expected an expression", span)

    def read_list(self) -> Cell:
        open_tok = self.next()  # '('
        items: List[Form] = []
        while True:
            kind, text, span = self.peek()
            if kind == "eof":
                raise SyntaxError_("unterminated list: missing ')'", (open_tok[2][0], len(self.src)))
            if kind == ")":
                self.next()
                return Cell(items, span=(open_tok[2][0], span[1]))
            if kind == "atom" and text == ".":
                raise SyntaxError_(
                    "本模块不支持点对形式，模式与参数请使用正规列表", span)
            items.append(self.read_form())


def end_span(f: Form) -> int:
    sp = get_span(f)
    return sp[1] if sp else 0


def parse_module(src: str) -> List[Form]:
    return Reader(src).read_all()
