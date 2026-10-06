# 宏卫生复核台（Macro Hygiene Review）

供航电规程团队在把可复用参数片段编入飞控脚本前，复核 **宏展开不会让模板临时变量捕获调用点的同名控制量**。

零第三方运行时依赖，仅需 Node.js ≥ 20（内置 `node:http` / `node:test` / `fetch`）。

## 受限语言

- 模块为 S 表达式，含 `lambda`、`let`、调用，以及 `define-syntax` + `syntax-rules`；
- 每模块 **至多 12 个宏**，每宏 **至多 8 条规则**；
- 重复仅支持 **一层** `...`；
- 顶层其余形式即被复核的调用点。

## 复核给出的结论

- **规范化展开**：`let` 归约为 lambda 立即调用；标识符按绑定身份标注 `名字#标签`；
- **每步命中的规则与调用位置**（区分“模块调用点”与“宏模板内嵌套调用”，含源文件行/列与片段）；
- **绑定身份对照**：拼写相同但身份标签不同即为不同绑定——明确显示调用点 `x` 与模板临时 `x` 属不同身份。

卫生语义：

- literal 按**词法绑定身份**匹配（free-identifier=?），不按拼写；被调用点局部同名遮蔽时不命中；
- 模式变量作为语法片段替换，**保留调用点绑定**；
- 模板内新引入的 `lambda`/`let` 绑定获得**稳定的新作用域**，只捕获模板自身的字面量引用。

## 错误处理（均定位首个相关源片段、给稳定证据并清除旧结论）

`NO_MATCHING_RULE`（附每条规则失败原因）、`REP_LENGTH_MISMATCH`、`UNBOUND_LITERAL`、
`RECURSION_LIMIT`（嵌套深度/应用次数）、`PARSE_ERROR`（语法不完整）等。
各顶层形式相互隔离、服务无状态：**递归超限不阻塞后续形式或后续模块复核**。

## 本地运行

```bash
npm test           # 宏卫生场景代码测试
npm run build      # 构建规程页面到 dist/
npm start          # 启动规程页面与 API（默认 :8080）
npm run verify     # 一次性验收：测试 + 构建 + HTTP/API 冒烟，退出码报告结果
```

- 规程页面：`GET /`
- 健康响应：`GET /healthz`
- 复核 API：`POST /api/review`，体：`{"source": "<模块文本>"}`

## Compose

```bash
HOST_PORT=9090 docker compose up --build web       # 可配置宿主端口（默认 8080）
docker compose build verify && docker compose up --build verify   # 一次性验收服务，完成即退出
# 查看验收结果：docker compose logs verify；退出码：docker compose inspect verify ... State.ExitCode
```

`verify` 服务在 Compose 网络内等待 `web` 健康后，完成代码测试、页面构建，
并对规程页面 `/`、健康地址 `/healthz`、复核 API `/api/review` 做冒烟，最后以退出码报告（0 全通过）。

## 目录

```
src/parser.js    词法/S 表达式解析（保留源偏移）
src/expander.js  词法身份解析、模式匹配、模板实例化、卫生展开与规范化
src/review.js    模块复核入口（结构化结论/错误）
src/server.js    规程页面 + /healthz + /api/review
src/build.js     一次性页面构建
scripts/verify.js 一次性验收服务
test/            node:test 宏卫生与错误场景
public/          规程页面（单文件）
```
