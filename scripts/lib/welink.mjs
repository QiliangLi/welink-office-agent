import { spawn } from 'node:child_process';
import { nowIso } from './utils.mjs';

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

  return new Promise((resolve) => {
    const startedAt = nowIso();
    const child = spawn('welink-cli', args, {
      shell: false,
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
