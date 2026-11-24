# 011 Codex 对话进桌面版记录，默认复用对话

状态：草案（2026-11-24）

## 背景（已查明）

- Codex 桌面版的对话列表只列"交互式来源"的对话。`codex exec` 建的对话来源是 `exec`，被过滤掉，所以只能用 `codex://threads/<ID>` 打开。本机桌面版自己建的对话来源都是 `vscode`。
- `codex exec` 没有选项能改这个来源（`--thread-source` 只是统计用的分类）。
- `codex app-server`（桌面版自己用的协议）有 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、`thread/name/set`：既能建会出现在列表里的对话，也能接着旧对话。
- 现在每次派发都跑一次 `codex exec`，每次都新开对话，上下文没法复用。

## 目标

1. 派出的 Codex 任务出现在 Codex 桌面版的对话列表里。
2. 默认接着同一仓库、同一角色上次用的对话做；需要时可以新开，或指定接着某个对话。

## 做法

### 1. Codex 适配器改用 app-server

- 启动 `codex app-server`（stdio），按 JSON-RPC 走：`initialize` → `thread/start` 或 `thread/resume` → `turn/start` → 等 `turn/completed` → 关闭。
- 每个任务的 model / effort / tier / sandbox 只作用于它自己这一轮；为 null 时不传，和现在一样。审批策略设为不询问；如果仍收到要用户批准的请求，一律拒绝，并记一条 `error` 事件，不能卡住。
- 非 git 目录：保持现在的报错和中文提示。
- 汇报：把最后一条 agent 消息写成汇报（适配器 `writesReport` 改为 false）。
- 统一事件和进度：同类动作产生和现在相同的 `kind` 与字段，`progress.log` 原有格式不变。
- `.log` 兼容（协议第 6 节）：现有的查看器读 `.log` 里的 exec 格式。把 app-server 的通知转换成和现在 `codex exec --json` 相同格式的行写进 `.log`（包括带 `thread_id` 的 `thread.started`），每行照旧补 `_at`。
- 停止、中断、托管、`--wait`、`--stop` 的行为不变：结束派发脚本的进程树，就结束了 app-server 和这一轮。

### 2. 对话复用

- **默认**：在 `runs.jsonl` 里找同一仓库（规范化路径）、同一角色（都没有角色也算同一类）最近一次用过的对话，接着它做；找不到就新开。
- `--new-thread`（不带值）：这次新开。
- `--thread <对话 ID>`：接着指定的对话，可以是在桌面版里开的。接不上就报错退出，不悄悄新开。
- 两个同时给：参数错误。
- 默认复用的对话接不上（被删除、归档，或 resume 失败）：新开，并在进度里说明。
- **同一个对话同一时间只跑一个任务**：对话正忙时，新任务等它结束再开始。等待期间进程不退出，任务在列表里显示为进行中，进度里写等待的那一行。用独占锁文件，同时派发也不会撞上。
- 新开的对话用 `thread/name/set` 起名：`派发：<仓库目录名>（<角色名>）`，没有角色时为 `派发：<仓库目录名>`。接着旧对话时不改名。

### 3. 文案（定稿）

进度（紧跟在首行和可能的「配置：」行之后）；非托管时，同一行也在「进度：」那行之后打印到标准输出：

| 情况 | 文案 |
|---|---|
| 新开 | `对话：新开 <ID>` |
| 接着上次 | `对话：接着上次的对话 <ID>` |
| 接着指定 | `对话：接着指定的对话 <ID>` |
| 等待 | `对话：<ID> 正在执行「<记录名>」，等它结束后开始` |
| 默认复用接不上 | `对话：上次的对话 <旧 ID> 接不上（<原因>），已新开 <新 ID>` |
| 指定的接不上 | `出错：接不上指定的对话 <ID>（<原因>）` |

监控软件（文案由设计负责人写进 `app/src/shared/copy.ts`）：

- 更多菜单加一项「在 Codex 中打开对话」，打开 `codex://threads/<ID>`。没有对话 ID 的任务（旧任务）不显示这一项。ID 必须是 UUID 格式才打开，防止拼出任意链接。
- 参数页加一行「Codex 对话」，值为 `<ID>（新开）`、`<ID>（接着上次的对话）` 或 `<ID>（指定的对话）`。

### 4. 协议新增（确认后由设计负责人写进 `docs/protocol.md`，都是 v1 内的可选内容）

- `runs.jsonl` 新事件 `thread`：`{ event: "thread", id, threadId, mode: "new" | "resume" | "specified", at }`。
- `progress.log` 新前缀 `对话：`。
- `<home>/threads/<threadId>.lock`：正在使用这个对话的任务 `{ id, pid, at }`，独占创建；持有进程已经不在就视为失效。
- 托管请求的 `args` 新增可选 `thread`（字符串或 null）、`newThread`（布尔）。
- 第 3 节 `.log` 的说明补一句：Codex 适配器写入的是转换成 exec 格式的事件行。

### 5. 发版

版本号 0.1.10 → 0.1.11，打出 Windows 安装包。用户装好后，在「连接」页更新技能。

## 不做什么

- 不改其他干活方（本版本只有 Codex）。
- 不连桌面版正在运行的 Codex 进程：桌面版的 app-server 只通过 stdio 自用，外部连不上。所以任务运行中，桌面版里不一定实时刷新，进展以 DispatchDock 为准。
- 不加改默认行为的配置项，不清理旧对话。
- 不改 SKILL.md 和 `copy.ts`：由设计负责人改，工程只在汇报里写需要同步的地方。

## 允许改动的文件

`skills/codex-dispatch/` 下的脚本、适配器和 `adapters/README.md`；`app/src/`（`shared/copy.ts` 除外）；`tests/`；`tools/verify-real-codex.mjs`；`package.json`、`package-lock.json` 的版本号。

## 验收

- `npm run verify` 通过。
- 假 app-server 测试覆盖：新开、默认复用、`--new-thread`、`--thread`（接上和接不上）、默认复用接不上改新开、同一对话排队、停止正在等待和正在运行的任务、审批请求被拒绝、非 git 目录提示、托管请求带新参数。
- 事件对照：用一段真实 app-server 输出（匿名化）做样例，统一事件和进度与同类动作在 exec 下一致；`.log` 里转换后的行交给现有的 exec 映射，得到同一份统一事件。
- 【实现时核实】真实 Codex（扩展 `tools/verify-real-codex.mjs`，在临时 git 仓库里）：
  1. 第一次派发新开对话；用 app-server 的 `thread/list`（不带 `sourceKinds`，也就是桌面版默认的过滤）能列出它；写明它的 source。
  2. 同一仓库再派一次：同一个对话 ID，对话里有两轮。
  3. `--new-thread`：新的对话 ID。
  4. 几乎同时派两个到同一对话：第二个等第一个结束。
  - 测试对话不要归档或删除，汇报里列出 ID，验收时设计负责人在桌面版里看。
- 截图：`npm run shots` 产出任务详情的参数页（带「Codex 对话」行）。
- 安装包：`npm run dist` 产出 0.1.11 安装包，路径写进汇报。

## 汇报要回答的问题

1. app-server 新开的对话 source 是什么，`thread/list` 默认能不能列出来。
2. 适配器接口改了哪些，`adapters/README.md` 是否已同步。
3. SKILL.md 需要同步的地方。

## 验收记录

（每轮验收后由设计负责人追加）
