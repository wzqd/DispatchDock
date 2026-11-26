import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskDetails } from '../skills/codex-dispatch/lib/options.mjs';

// 改动前（013 之前）发给 Codex 的固定说明，逐字照抄作对照样例。
const POPUP = '执行中不要弹出让用户选择或确认的提示。小的不一致（例如工具、浏览器的名字和任务说明写法不同，但显然是同一个东西）自己判断后继续，在汇报里写明；只有真正必须用户决定的事（付款、对外发布、登录、验证码、改账号设置等）才停下：直接结束本轮，在汇报里说明原因，不要弹窗等用户选。';
const ROLE = '你在本项目中的角色是「工程负责人」。';
const AGENTS = '请先阅读仓库根目录的 AGENTS.md（共同规则）。';
const ROLE_DOC = '再阅读你的角色文档 docs/roles/engineering.md，严格遵守其中的职责、硬规则、完成标准和汇报格式。';
const SPEC = 'docs/specs/014-示例 任务.md';

function repo(t, { agents }) {
  const base = mkdtempSync(join(tmpdir(), 'dispatchdock-prompt-')), root = join(base, '示例 仓库');
  mkdirSync(join(root, 'docs', 'roles'), { recursive: true });
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'roles', 'engineering.md'), '# 角色：工程负责人\n');
  writeFileSync(join(root, SPEC), '# 014\n');
  if (agents) writeFileSync(join(root, 'AGENTS.md'), '# 规则\n');
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  return { base, root };
}

const cases = [
  {
    title: '有 AGENTS.md、有角色、任务说明文件、有补充说明',
    agents: true, role: 'engineering', task: SPEC, extra: '补充说明',
    full: [ROLE, AGENTS, POPUP, ROLE_DOC, `然后完成任务说明 ${SPEC} 中的全部内容，按要求验证、提交，最后给出汇报。`, '补充说明'].join('\n'),
    short: [`继续以「工程负责人」的身份工作，规则同前（AGENTS.md、角色文档 docs/roles/engineering.md、不弹出确认提示）；这些文件在上次任务之后有新提交的，先重读。`,
      `新任务：完成任务说明 ${SPEC} 中的全部内容，按要求验证、提交，最后给出汇报。`, '补充说明'].join('\n'),
  },
  {
    title: '有 AGENTS.md、没有角色、任务文字',
    agents: true, task: '做一件事\n第二行', extra: '',
    full: [AGENTS, POPUP, '任务：\n做一件事\n第二行'].join('\n'),
    short: '规则同前（AGENTS.md、不弹出确认提示）；AGENTS.md 在上次任务之后有新提交的，先重读。\n新任务：\n做一件事\n第二行',
  },
  {
    title: '没有 AGENTS.md、有角色、任务文字和补充说明',
    agents: false, role: 'engineering', task: '只读调研', extra: '上次中断',
    full: [ROLE, POPUP, ROLE_DOC, '任务：\n只读调研', '上次中断'].join('\n'),
    short: '继续以「工程负责人」的身份工作，规则同前（角色文档 docs/roles/engineering.md、不弹出确认提示）；这些文件在上次任务之后有新提交的，先重读。\n新任务：\n只读调研\n上次中断',
  },
  {
    title: '没有 AGENTS.md、没有角色、任务说明文件',
    agents: false, task: SPEC, extra: '',
    full: [POPUP, `然后完成任务说明 ${SPEC} 中的全部内容，按要求验证、提交，最后给出汇报。`].join('\n'),
    short: `规则同前（不弹出确认提示）。\n新任务：完成任务说明 ${SPEC} 中的全部内容，按要求验证、提交，最后给出汇报。`,
  },
];

for (const c of cases) test('完整版与改动前逐字一致，简短版符合定稿：' + c.title, t => {
  const { root } = repo(t, c);
  const details = taskDetails(root, { opts: c.role ? { role: c.role } : {}, task: c.task, extra: c.extra });
  assert.equal(details.prompt, c.full);
  assert.equal(details.shortPrompt, c.short);
  // 说明部分是完整版里任务那一行之前的全部内容；判断对话历史时按“说明部分 + 换行”前缀比较。
  assert.ok(details.prompt.startsWith(details.instructions + '\n'));
  assert.ok(!details.instructions.includes('任务：') && !details.instructions.includes('然后完成任务说明'));
});

test('dry-run 依次打印完整版、分隔行和简短版，不创建记录目录', t => {
  const { base, root } = repo(t, { agents: true });
  const script = fileURLToPath(new URL('../skills/codex-dispatch/codex-task.mjs', import.meta.url));
  const env = { ...process.env, CODEX_DRY_RUN: '1', CODEX_DISPATCH_HOME: join(base, 'home'), CODEX_NO_WATCH: '1' };
  const r = spawnSync(process.execPath, [script, '做一件事', '--name', '预览', '--role', 'engineering'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const details = taskDetails(root, { opts: { role: 'engineering' }, task: '做一件事', extra: '' });
  assert.equal(r.stdout.trimEnd(), `记录名：预览\n----\n${details.prompt}\n----（接着已有同样完整说明的对话时，改发：）\n${details.shortPrompt}`);
  assert.equal(existsSync(join(root, '.codex-runs')), false);
  assert.equal(existsSync(join(base, 'home')), false);
});
