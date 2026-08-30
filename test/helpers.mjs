import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sourceRoot = path.resolve(new URL('..', import.meta.url).pathname);

/** Copy the portable package (scripts/config/server) into a temp fixture. */
export async function createFixture({ withServer = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'welink-agent-test-'));
  await fs.cp(path.join(sourceRoot, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  await fs.cp(path.join(sourceRoot, 'config'), path.join(dir, 'config'), { recursive: true });
  if (withServer) {
    await fs.cp(path.join(sourceRoot, 'server'), path.join(dir, 'server'), { recursive: true });
  }
  await fs.mkdir(path.join(dir, 'runtime'), { recursive: true });
  return dir;
}

export function runCli(root, commandArgs) {
  return new Promise((resolve, reject) => {
    const script = path.join(root, 'scripts/agent.mjs');
    const child = spawn(process.execPath, [script, ...commandArgs], { cwd: root, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        reject(new Error(`Invalid JSON output: ${stdout}\n${stderr}\n${error.message}`));
        return;
      }
      resolve({ code, parsed, stderr });
    });
  });
}

/** Start the Console API on an ephemeral port; returns { baseUrl, child, port }. */
export async function startServer(root) {
  const child = spawn(process.execPath, [path.join(root, 'server/index.mjs'), '--port', '0', '--no-static'], { cwd: root, shell: false });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  });
  return { child, port, baseUrl: `http://127.0.0.1:${port}/api/v1`, output };
}

export async function stopServer(child) {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.on('close', resolve));
  }
}
