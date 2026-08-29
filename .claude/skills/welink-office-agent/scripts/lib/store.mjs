import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, nowIso, pathExists, readJsonFile, readOptionalJson } from './utils.mjs';
import { makeId } from './ids.mjs';

export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.configDir = path.join(rootDir, 'config');
    this.runtimeDir = path.join(rootDir, 'runtime');
  }

  paths() {
    return {
      state: path.join(this.runtimeDir, 'agent-state.json'),
      tasks: path.join(this.runtimeDir, 'tasks'),
      items: path.join(this.runtimeDir, 'items'),
      approvals: path.join(this.runtimeDir, 'approvals'),
      actions: path.join(this.runtimeDir, 'actions'),
      logs: path.join(this.runtimeDir, 'logs'),
      raw: path.join(this.runtimeDir, 'raw')
    };
  }

  async initialize() {
    const directories = Object.values(this.paths()).filter((p) => !p.endsWith('.json'));
    await Promise.all(directories.map((dir) => ensureDir(dir)));

    const examples = ['owner', 'contacts', 'groups', 'routing', 'auto-reply', 'policies'];
    const copied = [];
    for (const name of examples) {
      const target = path.join(this.configDir, `${name}.json`);
      const example = path.join(this.configDir, `${name}.example.json`);
      if (!(await pathExists(target)) && (await pathExists(example))) {
        await fs.copyFile(example, target);
        copied.push(path.relative(this.rootDir, target));
      }
    }

    const statePath = this.paths().state;
    if (!(await pathExists(statePath))) {
      await this.writeJson(statePath, {
        schema_version: 1,
        status: 'idle',
        initialized_at: nowIso(),
        last_started_tick: null,
        last_successful_tick: null,
        active_task_ids: [],
        cursors: {}
      });
    }
    return { copied };
  }

  async loadConfig(name) {
    return readJsonFile(path.join(this.configDir, `${name}.json`));
  }

  async loadState() {
    return readJsonFile(this.paths().state);
  }

  async saveState(state) {
    state.updated_at = nowIso();
    await this.writeJson(this.paths().state, state);
  }

  async writeJson(filePath, data) {
    await ensureDir(path.dirname(filePath));
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(temp, filePath);
  }

  async appendJsonl(fileName, entry) {
    const filePath = path.join(this.paths().logs, fileName);
    await ensureDir(path.dirname(filePath));
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async logEvent(type, data = {}) {
    const event = {
      event_id: makeId('EVT'),
      type,
      timestamp: nowIso(),
      ...data
    };
    await this.appendJsonl('events.jsonl', event);
    return event;
  }

  async logMessage(message) {
    const entry = {
      log_id: makeId('LOG'),
      timestamp: nowIso(),
      ...message
    };
    await this.appendJsonl('messages.jsonl', entry);
    return entry;
  }

  taskPath(taskId) {
    return path.join(this.paths().tasks, `${taskId}.json`);
  }

  itemPath(itemId) {
    return path.join(this.paths().items, `${itemId}.json`);
  }

  approvalPath(approvalId) {
    return path.join(this.paths().approvals, `${approvalId}.json`);
  }

  actionPath(actionId) {
    return path.join(this.paths().actions, `${actionId}.json`);
  }

  async loadTask(taskId) {
    return readJsonFile(this.taskPath(taskId));
  }

  async saveTask(task) {
    task.updated_at = nowIso();
    await this.writeJson(this.taskPath(task.task_id), task);
  }

  async loadItem(itemId) {
    return readJsonFile(this.itemPath(itemId));
  }

  async saveItem(item) {
    item.updated_at = nowIso();
    await this.writeJson(this.itemPath(item.item_id), item);
  }

  async loadApproval(approvalId) {
    return readJsonFile(this.approvalPath(approvalId));
  }

  async saveApproval(approval) {
    approval.updated_at = nowIso();
    await this.writeJson(this.approvalPath(approval.approval_id), approval);
  }

  async saveAction(action) {
    action.updated_at = nowIso();
    await this.writeJson(this.actionPath(action.action_id), action);
  }

  async listJson(dirPath) {
    await ensureDir(dirPath);
    const names = await fs.readdir(dirPath);
    const records = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      records.push(await readJsonFile(path.join(dirPath, name)));
    }
    return records;
  }

  async listTasks() {
    return this.listJson(this.paths().tasks);
  }

  async listItems() {
    return this.listJson(this.paths().items);
  }

  async listApprovals() {
    return this.listJson(this.paths().approvals);
  }

  async listActions() {
    return this.listJson(this.paths().actions);
  }

  async readRaw(fileName) {
    return readOptionalJson(path.join(this.paths().raw, fileName), null);
  }
}
