import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

export function parseArgs(args) {
  const opts = {}, positional = [];
  const names = ['role', 'name', 'host', 'model', 'effort', 'tier', 'sandbox', 'watch-window', 'thread'];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (a === '--new-thread' || a === '--background') {
      opts[a === '--background' ? 'background' : 'newThread'] = true;
      continue;
    }
    if (a.startsWith('--')) {
      if (!names.includes(a.slice(2)) || !args[k + 1] || args[k + 1].startsWith('--')) throw new Error(`参数无效或缺少值：${a}`);
      opts[a.slice(2)] = args[++k];
    } else positional.push(a);
  }
  if (opts.thread && opts.newThread) throw Error('--thread 和 --new-thread 不能同时使用');
  if (!positional[0]) throw new Error('用法：node codex-task.mjs <任务说明文件 | "任务文字"> ["补充说明"] [--role <角色文档名>] [--name <记录名>] [--host <claude-code|devin>]');
  if (opts.host && !['claude-code', 'devin'].includes(opts.host)) throw new Error(`无效的派活方：${opts.host}`);
  return { opts, task: positional[0], extra: positional[1] ?? '' };
}

export const clipTitle = s => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

export function taskDetails(root, { opts, task, extra }) {
  const target = resolve(root, task);
  const spec = existsSync(target) && statSync(target).isFile() ? task : null;
  let role = null;
  if (opts.role) {
    const doc = /[\\/.]/.test(opts.role) ? opts.role : `docs/roles/${opts.role}.md`;
    if (!existsSync(resolve(root, doc))) throw new Error(`找不到角色文档：${resolve(root, doc)}`);
    const title = readFileSync(resolve(root, doc), 'utf8').split(/\r?\n/).find(l => l.startsWith('# ')) ?? '';
    role = { doc, name: title.replace(/^#\s*(角色[:：]\s*)?/, '').trim() || opts.role };
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const name = opts.name ?? (spec ? basename(spec, extname(spec)) : `task-${stamp}`);
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(`无效的记录名：${name}`);
  const hasAgents = existsSync(join(root, 'AGENTS.md'));
  const instructions = [
    role ? `你在本项目中的角色是「${role.name}」。` : '',
    hasAgents ? '请先阅读仓库根目录的 AGENTS.md（共同规则）。' : '',
    '执行中不要弹出让用户选择或确认的提示。小的不一致（例如工具、浏览器的名字和任务说明写法不同，但显然是同一个东西）自己判断后继续，在汇报里写明；只有真正必须用户决定的事（付款、对外发布、登录、验证码、改账号设置等）才停下：直接结束本轮，在汇报里说明原因，不要弹窗等用户选。',
    role ? `再阅读你的角色文档 ${role.doc}，严格遵守其中的职责、硬规则、完成标准和汇报格式。` : '',
  ].filter(Boolean).join('\n');
  const reminder = role
    ? `继续以「${role.name}」的身份工作，规则同前（${hasAgents ? 'AGENTS.md、' : ''}角色文档 ${role.doc}、不弹出确认提示）；这些文件在上次任务之后有新提交的，先重读。`
    : hasAgents ? '规则同前（AGENTS.md、不弹出确认提示）；AGENTS.md 在上次任务之后有新提交的，先重读。' : '规则同前（不弹出确认提示）。';
  const taskBody = [spec ? `完成任务说明 ${spec} 中的全部内容，按要求验证、提交，最后给出汇报。` : `\n${task}`, extra].filter(Boolean).join('\n');
  const prompt = `${instructions}\n${spec ? '然后' : '任务：'}${taskBody}`;
  const shortPrompt = `${reminder}\n新任务：${taskBody}`;
  return { spec, role, name, prompt, instructions, shortPrompt, title: spec ?? clipTitle(task) };
}

export function dispatcher(host, env, scriptPath) {
  host ??= env.CLAUDECODE === '1' ? 'claude-code' : /devin/i.test(scriptPath) ? 'devin' : 'unknown';
  // 本机环境及官方文档未核实到 Devin 会话环境变量，按任务要求留空。
  return { host, session: host === 'claude-code' ? env.CLAUDE_CODE_SESSION_ID || null : null };
}
