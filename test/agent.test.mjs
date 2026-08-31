import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath keeps this working on Windows (URL.pathname would produce
// a leading slash before the drive letter).
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function run(root, commandArgs) {
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

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'welink-agent-test-'));
  await fs.cp(path.join(sourceRoot, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  await fs.cp(path.join(sourceRoot, 'config'), path.join(dir, 'config'), { recursive: true });
  await fs.mkdir(path.join(dir, 'runtime'), { recursive: true });
  return dir;
}

test('initializes, creates a task, adds a subtask and dry-runs a message', async (t) => {
  const root = await fixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const init = await run(root, ['init']);
  assert.equal(init.code, 0);
  assert.equal(init.parsed.ok, true);

  const created = await run(root, ['create-task', '--title', '测试任务', '--request', '确认性能测试进展']);
  assert.equal(created.code, 0);
  const taskId = created.parsed.task.task_id;
  assert.match(taskId, /^TASK-/);

  const subtaskResult = await run(root, [
    'add-subtask', '--task-id', taskId,
    '--title', '询问张三',
    '--target-employee-number', '00123456',
    '--required-info', '当前状态,阻塞问题'
  ]);
  assert.equal(subtaskResult.code, 0);
  const subtaskId = subtaskResult.parsed.subtask.subtask_id;

  const sent = await run(root, [
    'send-user', '--employee-number', '00123456',
    '--task-id', taskId, '--subtask-id', subtaskId,
    '--text', '张哥，麻烦同步当前状态。'
  ]);
  assert.equal(sent.code, 0);
  assert.equal(sent.parsed.result.dry_run, true);
  assert.match(sent.parsed.action.content, /WELINK_AGENT_MESSAGE/);

  const status = await run(root, ['status', '--task-id', taskId]);
  assert.equal(status.code, 0);
  assert.equal(status.parsed.progress.waiting_reply, 1);
});

test('persists a dynamic item and blocks task completion', async (t) => {
  const root = await fixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await run(root, ['init']);

  const created = await run(root, ['create-task', '--request', '收集测试进展']);
  const taskId = created.parsed.task.task_id;
  const itemResult = await run(root, [
    'add-item', '--task-id', taskId,
    '--description', '组织评审会议',
    '--relation', 'scope_extension',
    '--workload', 'large'
  ]);
  assert.equal(itemResult.code, 0);
  assert.match(itemResult.parsed.item.item_id, /^ITEM-/);

  const completion = await run(root, ['complete-task', '--task-id', taskId]);
  assert.equal(completion.code, 2);
  assert.equal(completion.parsed.ok, false);
  assert.equal(completion.parsed.blocking.open_items.length, 1);
});
