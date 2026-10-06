#!/usr/bin/env python3
"""One-shot acceptance service: macro-hygiene code tests, page build check,
and API/HTTP smoke against the procedure page and health endpoint.

* In Compose it runs as the ``verify`` service with BASE_URL=http://web:8080
  after the web service is healthy, then exits with a status code.
* Standalone (BASE_URL unset) it boots the HTTP server itself on an ephemeral
  port, performs the same checks, and tears the server down.

Exit code 0 = acceptance passed, non-zero = failed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from app.server import Handler, PAGE  # noqa: E402

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  [{PASS if cond else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def http(method: str, url: str, payload: dict | None = None, timeout: float = 5.0):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def wait_healthy(base: str, attempts: int = 30) -> bool:
    for _ in range(attempts):
        try:
            status, body = http("GET", f"{base}/health")
            if status == 200 and json.loads(body)["status"] == "ok":
                return True
        except (OSError, urllib.error.URLError, ValueError):
            time.sleep(0.5)
    return False


def code_tests() -> bool:
    print("1) 宏卫生场景代码测试 (unittest)")
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=HERE, capture_output=True, text=True)
    tail = "\n".join(proc.stdout.splitlines()[-3:])
    ok = proc.returncode == 0
    check("unittest discover -s tests", ok, tail.strip())
    if not ok:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
    return ok


def page_build() -> bool:
    print("2) 规程页面构建校验")
    ok_file = os.path.isfile(PAGE) and os.path.getsize(PAGE) > 1000
    check("static/index.html 产物存在且非空", ok_file, PAGE)
    required = ["宏卫生展开复核台", "/api/review", "规范化展开结果",
                "逐步展开命中记录", "卫生判定", "clearConclusions"]
    text = open(PAGE, encoding="utf-8").read() if ok_file else ""
    missing = [m for m in required if m not in text]
    check("页面包含复核台、API 调用与各结论区块", not missing,
          "缺失: " + ", ".join(missing) if missing else f"{len(text)} 字节")
    return ok_file and not missing


def smoke(base: str) -> bool:
    print(f"3) 页面与健康地址 API/HTTP 冒烟 ({base})")
    ok_health = wait_healthy(base)
    check("GET /health 返回 status=ok", ok_health)

    try:
        status, body = http("GET", f"{base}/")
        page = body.decode()
    except OSError:
        status, page = 0, ""
    check("GET / 返回规程页面 200", status == 200 and "宏卫生展开复核台" in page,
          f"HTTP {status}")

    # --- hygienic expansion scenario (nested macro, call-site x vs template x)
    module = """
    (define-syntax with-x
      (syntax-rules ()
        ((with-x body) (let ((x 99)) body))))
    (define-syntax call-with-x
      (syntax-rules ()
        ((call-with-x v) (with-x v))))
    (let ((x 1)) (call-with-x x))
    """
    try:
        status, body = http("POST", f"{base}/api/review", {"source": module})
        data = json.loads(body)
    except (OSError, ValueError) as e:
        data, status = {}, 0
        print("    request error:", e)
    check("POST /api/review 卫生场景返回 200/ok", status == 200 and data.get("ok"))
    steps = data.get("steps", [])
    check("记录两次嵌套宏展开步骤", len(steps) == 2, f"{len(steps)} 步")
    if steps:
        check("步骤含命中规则编号与调用位置",
              all(s.get("ruleIndex") and s.get("callLine") for s in steps))
        check("第二次调用标记为模板引入",
              steps[1].get("callOrigin") == "macro-template")
    norm = data.get("normalized", "")
    check("规范化结果中调用点 x 解析为 B1，模板临时 x 为 B2",
          "(x⁽B2⁾ 99)" in norm and "x⁽B1⁾" in norm, norm)
    checks = data.get("hygieneChecks", [])
    distinct = [c for c in checks if c.get("name") == "x" and c.get("verdict") == "distinct"]
    check("明确给出同名 x 属于不同绑定身份", bool(distinct),
          distinct[0]["message"][:60] if distinct else "")
    if distinct:
        origins = {b["origin"] for b in distinct[0]["bindings"]}
        check("两个身份分别标注宏模板/调用点来源",
              origins == {"macro-template", "source"}, str(origins))

    # --- lexical literal, not spelling
    lit_module = """
    (define-syntax my-if
      (syntax-rules (if)
        ((my-if if c t e) (list c t e))
        ((my-if q c t e) (list q c t e))))
    (lambda (if) (my-if if 1 2 3))
    """
    _, body = http("POST", f"{base}/api/review", {"source": lit_module})
    d = json.loads(body)
    check("literal 按词法绑定：局部 if 不匹配 literal，命中规则2",
          d["ok"] and d["steps"][0]["ruleIndex"] == 2)

    # --- error scenarios: located first fragment, stable evidence, cleared
    def expect_error(src, kind):
        _, b = http("POST", f"{base}/api/review", {"source": src})
        return json.loads(b)

    d = expect_error("(define-syntax f (syntax-rules () ((f a b) a)))\n(f 1)",
                     "no-rule-match")
    check("规则无匹配：定位调用并给出稳定证据",
          (not d["ok"] and d["error"]["kind"] == "no-rule-match"
           and d["error"]["line"] == 2 and d["error"]["evidence"].startswith("EV-")
           and d["steps"] == [] and d["normalized"] == ""),
          d.get("error", {}).get("evidence", ""))

    d = expect_error(
        "(define-syntax p (syntax-rules () "
        "((p (a ...) (b ...)) (list (cons a b) ...))))\n(p (1 2) (3 4 5))",
        "repetition-mismatch")
    check("重复变量长度不一致报错",
          d["error"]["kind"] == "repetition-mismatch" and "a=2" in d["error"]["message"])

    d = expect_error("(define-syntax b (syntax-rules (zzz!) ((b zzz!) 1)))\n(b 1)",
                     "unbound-literal")
    check("未绑定 literal 在定义处报错", d["error"]["kind"] == "unbound-literal")

    d = expect_error(
        "(define-syntax loop (syntax-rules () ((loop) (loop))))\n(loop)",
        "recursion-limit")
    check("递归超限报错且不阻塞", d["error"]["kind"] == "recursion-limit")

    d2 = expect_error("(define-syntax z (syntax-rules () ((z) 1)))\n(z)", "ok")
    check("递归超限后后续合法模块仍可复核（状态隔离）", d2["ok"] and d2["normalized"])

    d = expect_error("(define-syntax x (syntax-rules () ((x a) a))\n(x 1)",
                     "incomplete-syntax")
    check("语法不完整定位首个相关源片段",
          d["error"]["kind"] == "incomplete-syntax" and bool(d["error"]["snippet"]))

    # evidence stability across identical reviews
    e1 = expect_error("(define-syntax f (syntax-rules () ((f a b) a)))\n(f 1)", "")
    e2 = expect_error("(define-syntax f (syntax-rules () ((f a b) a)))\n(f 1)", "")
    check("稳定证据对同一模块两次复核一致",
          e1["error"]["evidence"] == e2["error"]["evidence"])

    bad_resp = urllib.request.Request(f"{base}/api/review",
                                      data=b"not-json", method="POST",
                                      headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(bad_resp, timeout=5)
        bad_ok = False
    except urllib.error.HTTPError as e:
        bad_ok = e.code == 400
    check("非法请求体返回 400", bad_ok)

    return not failures


def main() -> int:
    print("== 宏卫生复核台 · 一次性验收 ==")
    code_tests()
    page_build()

    base = os.environ.get("BASE_URL")
    server = None
    if not base:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        base = f"http://127.0.0.1:{port}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"   (本地模式：临时服务启动于 {base})")
    try:
        smoke(base)
    finally:
        if server is not None:
            server.shutdown()

    print("=" * 48)
    if failures:
        print(f"{FAIL} 验收未通过：{len(failures)} 项 — {failures}")
        return 1
    print(f"{PASS} 验收全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
