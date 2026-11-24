# 012 派发的 Codex 对话默认「帮我批准」

状态：已验收（2026-11-24）

## 背景（2026-11-24 本机实测）

- 011 新开对话时写的是 `approvalPolicy: "never"`（从不询问）：越出沙箱的操作直接失败，不经任何审查。
- 用户希望派发的对话是桌面版里的「帮我批准」。实测这个模式在对话记录（rollout 的 `turn_context`）里是：`approval_policy: "on-request"`、`approvals_reviewer: "auto_review"`、`sandbox_policy: "workspace-write"`。用户在桌面版里把权限切成「帮我批准」后发的那一轮，和用 app-server 以这三项建对话时跑的那一轮，记录完全一样。
- 桌面版打开对话时，权限下拉显示的是它自己的默认值（实测显示「请求批准」），不读对话里存的设置。桌面版执行排队消息时用的是对话里存的设置（011 真实验证第 7 项）。所以派发的任务按对话设置执行，下拉显示由用户在桌面版自己的设置里调整，派发这边不管。

## 目标

派发新开的对话按「帮我批准」执行：越出沙箱的请求交给 Codex 的自动审查决定，不弹给用户，也不直接失败。

## 做法

- 新开对话时（交给桌面版和后台执行两种方式都一样），`thread/start` 传 `approvalPolicy: "on-request"`、`approvalsReviewer: "auto_review"`，替换原来的 `approvalPolicy: "never"`。沙箱照旧按设置传。
- 后台执行的 `turn/start` 如果传了审批参数，同样改为这两项。
- 后台执行时如果仍有审批请求发到派发脚本（例如服务端没走自动审查），照旧一律拒绝并记一条 `error`，不能卡住。
- 接着旧对话时不改它原来的设置（和 011 一致）。
- 版本号不变：0.1.11 还没发出也没安装，在它上面重打安装包。

## 不做什么

- 不改桌面版的权限下拉显示，不读写桌面版的设置。
- 不加配置项（以后要可选再说）。
- 不改协议文件、界面和文案。

## 允许改动的文件

`skills/codex-dispatch/adapters/` 下和建对话、发起一轮相关的文件及 `adapters/README.md`；`tests/` 里对应的测试和假 app-server；`tools/verify-real-codex.mjs`（第 7 项的预期改为 `on-request` + `auto_review`）。

## 验收

- `npm run verify` 通过。
- 假 app-server 测试：两种执行方式新开对话时，`thread/start` 收到的是 `approvalPolicy: "on-request"`、`approvalsReviewer: "auto_review"`；接着旧对话时不传；收到审批请求时仍然拒绝并记 `error`。
- 真实验证：只跑一次交给桌面版的新开派发（不用整套），读这一轮的 `turn_context`，确认 `approval_policy` 为 `on-request`、`approvals_reviewer` 为 `auto_review`，写出对话 ID 作证据。
- `npm run dist` 重打 0.1.11 安装包（Smart App Control 拦截时用 011 那次的静态提取办法，不改系统设置），给出路径和 SHA-256。
- 提交（`[工程]`），不推送。

## 汇报要回答的问题

1. 改了哪几处建对话、发起一轮的调用。
2. 真实验证那一轮的对话 ID 和 `turn_context` 里的两个字段。

## 验收记录

### 第 1 轮 · 2026-11-24 · 通过

- 工程提交 `8b85bc6`，4 个文件，均在允许范围内。`thread/start` 改为 `approvalPolicy: "on-request"` + `approvalsReviewer: "auto_review"`；后台续接的 `thread/resume` 去掉了原来的 `never` 覆盖，续接时沿用对话原有设置，与方案一致。
- `npm run verify` 246 通过、8 跳过、0 失败。
- 真实验证：对话 `01a20d0e-a1bd-7c41-95c1-88c994ed125c`。设计负责人直接读了它的 rollout：准备轮和桌面版执行的那一轮，`turn_context` 都是 `on-request` / `auto_review` / `workspace-write`，模型 `gpt-6.2-astra`。
- 安装包重打后核对了 SHA-256，包内适配器已是新版。设计负责人随后在 SKILL.md 补了一句"新开的对话按「帮我批准」执行"，并重打了安装包。
