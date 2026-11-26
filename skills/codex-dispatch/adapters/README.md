# 干活方适配器

技能只依赖 Node 24 内置模块。分发时复制整个 `codex-dispatch/`，保留 `lib/`、`adapters/` 和入口的相对位置。

当前入口只接入 `codex`。公共层处理参数、配置、记录名、清单、进度、窗口和生命周期；适配器负责检测、执行和原始事件映射。不要在公共层再次判断 Codex 的事件类型。

## 接口

| 成员 | 约定 |
|---|---|
| `id` | 清单中的干活方标识，当前为 `codex` |
| `writesReport` | 是否由干活方写 `report`。为 `false` 时公共层把最后一条 `say.text` 原样写入；没有 `say` 时不虚构汇报 |
| `detect({env, settings})` | 返回（或异步返回）`{installed, version}`；取不到版本写 `null`，可携带适配器私有的 `launcher` / `error`。检测只运行版本命令，不发任务 |
| `execute(context)`（多进程适配器） | 异步执行一次派发，返回 `{code, signal?}`。Codex 用此接口管理 app-server、队列、后台对话锁和只读轮询 |
| `command({root, report, prompt, settings, detection, env})` | 返回 `{executable, args, stdin}`，分别为可执行文件、字符串数组、输入文本。公共层固定 `shell:false`；检测结果原样传回此处 |
| `mapLine(line, {root})` | 一行 stdout 转成零到多个事件数组。事件只含协议规定的 `kind` 及附加字段，`v/seq/at` 由公共层追加。未知 JSON 事件丢弃，非空非 JSON 行转 `text` |
| `failureHint(stderr)`（可选） | 干活方非 0 退出时，公共层先把 stderr 末尾几行写成一条 `error` 事件；适配器认得这类原因时返回一句中文说明（写成第二条 `error`），认不得返回 `null` |

实现 `execute` 的适配器优先走该入口。上下文有 `root/home/id/title/role/prompt/instructions/shortPrompt/opts/settings/explicitSettings/env/detection`。

- `prompt` 是完整版指令；`instructions` 是其中任务那一行之前的说明部分；`shortPrompt` 是简短版（一行提醒 + 任务 + 补充说明）。
- 适配器确定对话后选用一版：接着已有的对话，且对话最近 50 轮里有一条用户消息以 `instructions + '\n'` 开头时，发 `shortPrompt` 并 `announce` 一行 `指令：…`；新开对话、没找到或读历史失败时发 `prompt`。排队、发起一轮、按全文匹配本次轮次都要用实际发出的那一版。Codex 适配器用 `thread/turns/list` 的 `itemsView: "summary"` 读历史（只含用户消息和回复，数据量小）。
- 单进程 `command` 接口不涉及对话，始终用 `prompt`。

回调如下。

- `spawned(pid, primary = true)` 跟踪子进程，返回的函数在子进程退出时调用。仅主执行者或观察者的 PID 公布到清单，短暂试探写入权的进程传 `false`。
- `thread({threadId, mode, runner})` 写 v1 对话事件。执行位置变化时再写一次。
- `announce(text)` 写进度。直接派发时也打印到标准输出。
- `write(execEvent)` 写带 `_at` 的兼容日志，然后通过 `mapLine` 生成统一事件。后台使用通知，桌面使用该轮的条目快照。最后一条 `say` 是汇报。准备轮只检查结果。

以下为单进程 `command` 接口的约定。`root`、`report` 是绝对路径。`settings` 包含 `model/effort/tier/sandbox/path/watchWindow`。模型、强度、档位为 `null` 时不得拼入参数。stdout 会同时存入原始日志，JSON 对象补 `_at`；stderr 保持旧版原文写入方式；非 0 退出时末尾几行另作 `error` 事件。后台运行（非交互）且退出码非 0 时，所有 `error` 事件在 `exit=` 行之前逐条打印为“出错：…”，托管时由等待者从事件文件读出后打印。命令退出等待 `close`，确保所有输出读取完毕后才写 `end`。

统一事件以 [文件协议](../../../docs/protocol.md) 为准。`say/think` 保留完整换行；命令 `start/end` 用同一个 `id`；命令结果按前 200 行且最多 16384 字节截断；文件路径相对 `root`，使用 `/` 分隔。`progress.log` 只调用公共 `formatProgress`，不能再解析原始事件。

## 最小模板

以下仅演示接口，不是已接入的其他干活方。实际接入前须先确认协议、配置和安装器支持范围。

```js
import { spawnSync } from 'node:child_process';

export function makeAdapter(executable) {
  return {
    id: 'example',
    writesReport: false,
    detect({ env }) {
      const r = spawnSync(executable, ['--version'], {
        env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
      });
      return { installed: r.status === 0, version: r.status === 0 ? r.stdout.trim() : null };
    },
    command({ prompt }) {
      return { executable, args: ['--stdin'], stdin: prompt };
    },
    mapLine(line) {
      // 根据目标工具实际输出协议替换此处；文本会成为最终汇报。
      return line.trim() ? [{ kind: 'say', text: line }] : [];
    },
  };
}
```

## Codex 启动与配置

- `agents.codex.path` 有值时直接使用，不查 PATH；Node 入口（`.js` / `.mjs` / `.cjs`）用 `process.execPath`，可执行文件直接启动，`.cmd` / `.bat` 按 npm 包装解析；文件不存在或包装不支持则报错。未设置时在 PATH 中查找 `codex.exe` 或 npm `codex.cmd`。标准 npm 包装解析为 Node 入口，用 `process.execPath` 启动；不经过 shell，因此空格和中文参数不会被拆开。未识别的批处理包装明确报错，不猜测脚本语义。
- 参数：保留任务文字 / 文件、补充说明、`--role`、`--name`；新增 `--host`、`--model`、`--effort`、`--tier`、`--sandbox`、`--watch-window`。优先级为命令行 > 环境变量 > `config.json` > 内置默认。
- `CODEX_DISPATCH_HOME` 优先指定公共目录。模型、强度、档位默认 `null`，沙箱默认 `workspace-write`，窗口默认 `auto`。`CODEX_NO_WATCH` 的非空值沿用旧行为，禁用窗口；显式 `--watch-window` 优先。
- `CODEX_DRY_RUN` 非空时只打印去重后的记录名和任务指令，不检测 agent，不创建目录或文件。
- `CODEX_DISPATCH_TEST_AGENT` 仅供测试，指定一个 Node 脚本代替 Codex 入口。正常派发不要设置。自动测试使用临时目录和假进程；`npm run verify` 不访问真实 agent。
- `auto` 在非交互 Windows 环境且查看器未接管时打开窗口；`always` 忽略查看器接管，仍保留旧版交互终端不重复弹窗的行为；`never` 禁止弹窗。
- 占好记录名后立即打印“记录名：”和“进度：”两行。配置缺失或无效时，“配置：”提示紧跟进度首行，并打印到标准输出。所有错误前缀统一为“出错：”；PowerShell 包装去壳和转义与现有的查看器对齐。
- `--config` 查看默认值与来源，`--config 键=值` 修改，值 `-` 写入 null；`--config init` 只在配置不存在时创建。配置写入保留未知字段，先写临时文件再改名。
- 在目标仓库运行 `node "<技能目录>/codex-task.mjs" --wait [记录名]`，只读等待已有任务并返回原退出码；省略记录名时取当前仓库最近开始的任务。

## 对话与桌面交接

- 同一规范化仓库路径和角色默认复用最近的 Codex 对话。`--new-thread` 新建，`--thread <UUID>` 指定，两者互斥。
- 默认交给已关联 `codex://` 的桌面版。`--background` 或缺少关联时由 app-server 在后台运行。后台遇到桌面写入者时改为排队。
- 两种方式新开对话时都在 `thread/start` 设置 `approvalPolicy: "on-request"` 和 `approvalsReviewer: "auto_review"`，由 Codex 自动审查越出沙箱的请求。后续轮次和续接的对话沿用已有审批设置。后台若仍收到审批请求，派发脚本会回复拒绝并记录一条 `error` 事件。
- 新对话命名后，桌面方式先运行固定准备消息并释放写入权。占用探测在 `codex queue` 入队前完成，空闲对话随后通过链接打开。复用桌面对话时使用对话原有设置。只有派活方显式指定模型、强度、档位或沙箱时才写进度提示，托管请求通过 `args.overrides` 传递来源。
- 观察者把队列条目的 `id` 和 `clientUserMessageId` 与历史中的 `userMessage.id/clientId` 对上，随后固定跟踪 `turn.id`。遇到缺少标识的历史时，只在入队前边界以后的轮次中比对完整指令。可能串单时报告错误。
- 每约一秒读取轮次和分页条目。桌面历史缺少 token 计数时写 null。后台命令和进展由实时通知驱动。后台同对话持有进程锁。支持从命令行和软件停止后台任务，桌面任务可在 Codex 中打开并停止。

手动真实验收在仓库根目录运行 `node tools/verify-real-codex.mjs`。桌面版已运行时自动跳过冷启动。脚本使用现有 Codex 登录状态和临时 git 仓库，会把桌面版切到前台。模型与强度可用 `--model`、`--effort` 指定。对话 ID、轮次采样和逐项结果写入终端所列的临时证据目录。
