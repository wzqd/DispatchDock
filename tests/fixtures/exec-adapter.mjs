// 保留单进程适配器契约与旧 exec 样例的回归覆盖。
import { codex, resolveLauncher } from '../../skills/codex-dispatch/adapters/codex.mjs';
export const execAdapter = { ...codex, execute: undefined, writesReport: true,
  command({ root, report, prompt, settings, detection, env = process.env }) {
    const launcher = detection?.launcher ?? resolveLauncher(env, process.platform, settings.path);
    const args = [...launcher.args, 'exec', '--json', '-C', root];
    if (settings.model != null) args.push('-m', settings.model);
    if (settings.effort != null) args.push('-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`);
    if (settings.tier != null) args.push('-c', `service_tier=${JSON.stringify(settings.tier)}`);
    if (settings.sandbox != null) args.push('-s', settings.sandbox);
    args.push('-o', report, '-');
    return { executable: launcher.executable, args, stdin: prompt };
  },
};
