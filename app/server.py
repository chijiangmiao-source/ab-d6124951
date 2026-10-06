"""Review page / API HTTP service (Python standard library only).

Endpoints
---------
GET  /                 procedure review page (static HTML)
POST /api/review       {"source": "<module>"} -> normalized expansion report
GET  /health           liveness JSON
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .engine import MAX_MACROS, MAX_RULES, ReviewResult, review

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "static", "index.html")
MAX_BODY = 256 * 1024

SAMPLE_MODULE = """\
(define-syntax with-x
  (syntax-rules ()
    ((with-x body) (let ((x 99)) body))))

(define-syntax call-with-x
  (syntax-rules ()
    ((call-with-x v) (with-x v))))

(let ((x 1))
  (call-with-x x))
"""


def _step_json(s) -> dict:
    return {
        "id": s.step_id,
        "macro": s.macro,
        "ruleIndex": s.rule_index,
        "rulePattern": s.rule_pattern,
        "ruleTemplate": s.rule_template,
        "callSpan": list(s.call_span),
        "callLine": s.call_line,
        "callColumn": s.call_column,
        "callOrigin": s.call_origin,
        "introScope": s.intro_scope,
        "useScope": s.use_scope,
        "before": s.before,
        "after": s.after,
        "origins": s.origins,
    }


def result_to_dict(r: ReviewResult) -> dict:
    return {
        "ok": r.ok,
        "macroCount": r.macro_count,
        "error": r.error,
        "steps": [_step_json(s) for s in r.steps],
        "normalized": r.normalized,
        "identities": r.identities,
        "hygieneChecks": r.hygiene_checks,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "AvionicsReview/1.0"

    def log_message(self, fmt, *args):  # quiet container logs
        pass

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"status": "ok", "service": "macro-review"})
            return
        if path == "/":
            try:
                with open(PAGE, "rb") as fh:
                    body = fh.read()
            except OSError:
                self._send_json(500, {"status": "error", "message": "页面缺失"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/sample":
            self._send_json(200, {"source": SAMPLE_MODULE})
            return
        self._send_json(404, {"status": "error", "message": "not found"})

    def do_POST(self):
        try:
            self._do_post()
        except Exception as exc:  # never leak a stack trace to the reviewer
            self._send_json(200, {
                "ok": False,
                "error": {"kind": "incomplete-syntax",
                          "message": f"复核服务内部错误: {exc.__class__.__name__}: {exc}",
                          "evidence": "EV-internal", "line": 0, "column": 0,
                          "snippet": "", "span": None},
                "steps": [], "normalized": "", "identities": [],
                "hygieneChecks": [], "macroCount": 0,
            })

    def _do_post(self):
        path = urlparse(self.path).path
        if path != "/api/review":
            self._send_json(404, {"status": "error", "message": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"ok": False,
                                  "error": {"kind": "bad-request",
                                            "message": "请求体须为非空 JSON 且不超过 256KiB"}})
            return
        try:
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            source = data["source"]
            if not isinstance(source, str):
                raise ValueError
        except (ValueError, KeyError, UnicodeDecodeError):
            self._send_json(400, {"ok": False,
                                  "error": {"kind": "bad-request",
                                            "message": "请求体须为 {\"source\": \"...\"}"}})
            return
        if not source.strip():
            self._send_json(200, {"ok": True, "macroCount": 0, "steps": [],
                                  "normalized": "", "identities": [],
                                  "hygieneChecks": [],
                                  "error": None})
            return
        r = review(source)
        self._send_json(200, result_to_dict(r))

def run(host: str = "0.0.0.0", port: int = 8080) -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"macro-review listening on {host}:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    run(host, port)
