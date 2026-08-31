import { execFile, spawn } from 'node:child_process';
import { nowIso } from './utils.mjs';

/**
 * On Windows npm installs welink-cli as a .cmd shim: spawning it without a
 * shell fails (ENOENT on older Node, EINVAL on newer Node), and routing
 * message content through cmd.exe quoting is unsafe. npm also writes the
 * extensionless Node bin script next to the shim, so we resolve that once
 * and run it with process.execPath — plain argv, no shell involved.
 */
let resolvedWelinkCommand = null;

function quoteCmdArg(arg) {
  if (!/[\s"^&|<>()%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

async function resolveWelinkCommand() {
  if (process.platform !== 'win32') return { file: 'welink-cli', args: [], shell: false };
  if (!resolvedWelinkCommand) {
    const locations = await new Promise((resolve) => {
      execFile('cmd.exe', ['/d', '/s', '/c', 'where welink-cli'], (error, stdout) => resolve(error ? '' : stdout));
    });
    const candidates = locations.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const script = candidates.find((file) => !/\.(cmd|bat|exe|ps1)$/i.test(file));
    resolvedWelinkCommand = script
      ? { file: process.execPath, args: [script], shell: false }
      : { file: 'welink-cli', args: [], shell: true };
  }
  return resolvedWelinkCommand;
}

export async function runWelink(args, options = {}) {
  const { timeoutMs = 60000, dryRun = false } = options;
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      command: ['welink-cli', ...args],
      stdout: '',
      stderr: '',
      exit_code: 0,
      started_at: nowIso(),
      completed_at: nowIso()
    };
  }

  const command = await resolveWelinkCommand();
  const spawnArgs = [...command.args, ...args];
  // Shell fallback path only (Windows without a resolvable bin script):
  // cmd.exe needs each argument quoted itself.
  const file = command.shell ? ['welink-cli', ...spawnArgs.map(quoteCmdArg)].join(' ') : command.file;

  return new Promise((resolve) => {
    const startedAt = nowIso();
    const child = spawn(file, command.shell ? [] : spawnArgs, {
      shell: command.shell,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        dry_run: false,
        command: ['welink-cli', ...args],
        stdout,
        stderr: `${stderr}${error.message}`,
        exit_code: null,
        timed_out: timedOut,
        started_at: startedAt,
        completed_at: nowIso()
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        dry_run: false,
        command: ['welink-cli', ...args],
        stdout,
        stderr,
        exit_code: code,
        timed_out: timedOut,
        started_at: startedAt,
        completed_at: nowIso()
      });
    });
  });
}
