import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
import { validThreadId } from '../lib/paths.mjs';
const association = `Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class Associations { [DllImport("Shlwapi.dll", CharSet=CharSet.Unicode)] public static extern int AssocQueryString(uint flags, uint kind, string scheme, string verb, StringBuilder value, ref uint size); }'; $size=[uint32]2048; $value=New-Object Text.StringBuilder 2048; if ([Associations]::AssocQueryString(0x1000,4,"codex",$null,$value,[ref]$size) -ne 0 -or !$value.Length) { exit 1 }`;

export const desktop = {
  async installed(env) {
    const options = { env, shell: false, windowsHide: true, timeout: 8000 };
    try {
      if (process.platform === 'win32') await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', association], options);
      else if (process.platform === 'darwin') await execute('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); if (!$.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('codex://threads')).path.js) throw Error('missing')"], options);
      else return !!(await execute('xdg-mime', ['query', 'default', 'x-scheme-handler/codex'], options)).stdout.trim();
      return true;
    } catch { return false; }
  },
  async open(id, env) {
    if (!validThreadId(id)) throw Error('Codex 对话 ID 无效');
    const url = 'codex://threads/' + id;
    const [file, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    await execute(file, args, { env, shell: false, windowsHide: true, timeout: 10000 });
  },
};
