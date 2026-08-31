import fs from 'node:fs/promises';
import path from 'node:path';
import { LockManager } from './locks.mjs';
import { ensureDir, nowIso, pathExists, readJsonFile, readOptionalJson } from './utils.mjs';
import { makeId } from './ids.mjs';

/**
 * Single owner of every runtime read/write. All read-after-write changes to
 * Task, Approval, Item, Action, Command, Conversation and AgentState must go
 * through the mutate* helpers so file locks and revisions are enforced in one
 * place. Snapshot writes keep temp file + rename for atomic replacement.
 */
export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.configDir = path.join(rootDir, 'config');
    this.runtimeDir = path.join(rootDir, 'runtime');
    this.locks = new LockManager(path.join(this.runtimeDir, '.locks'));
  }

  paths() {
    return {
      state: path.join(this.runtimeDir, 'agent-state.json'),
      tasks: path.join(this.runtimeDir, 'tasks'),
      items: path.join(this.runtimeDir, 'items'),
      approvals: path.join(this.runtimeDir, 'approvals'),
      actions: path.join(this.runtimeDir, 'actions'),
      commands: path.join(this.runtimeDir, 'commands'),
      conversations: path.join(this.runtimeDir, 'conversations'),
      idempotency: path.join(this.runtimeDir, 'idempotency'),
      logs: path.join(this.runtimeDir, 'logs'),
      raw: path.join(this.runtimeDir, 'raw'),
      locks: path.join(this.runtimeDir, '.locks')
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
        revision: 1,
        status: 'idle',
        initialized_at: nowIso(),
        last_started_tick: null,
        last_successful_tick: null,
        active_task_ids: [],
        cursors: {},
        log_sequence: 0
      });
    }
    return { copied };
  }

  async loadConfig(name) {
    return readJsonFile(path.join(this.configDir, `${name}.json`));
  }

  /**
   * Locked read-modify-write of config/*.json for deterministic console
   * edits (e.g. the contacts whitelist). LockManager sanitizes the key to
   * NTFS-safe characters, so Windows lock files stay creatable.
   *
   * Only a missing file starts from an empty config; a malformed or
   * unreadable file must abort the write — treating a parse error as an
   * empty object would silently replace the owner's hand-maintained
   * config (data loss).
   */
  async mutateConfig(name, mutator) {
    return this.locks.withLocks([`config-${name}`], async () => {
      let config;
      try {
        config = await this.loadConfig(name);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        config = {};
      }
      await mutator(config);
      await this.writeJson(path.join(this.configDir, `${name}.json`), config);
      return config;
    });
  }

  async loadState() {
    const state = await readJsonFile(this.paths().state);
    if (typeof state.log_sequence !== 'number') state.log_sequence = 0;
    return state;
  }

  async saveState(state) {
    state.updated_at = nowIso();
    state.revision = (state.revision ?? 0) + 1;
    await this.writeJson(this.paths().state, state);
  }

  /** Locked mutation of agent-state.json; the only safe read-modify-write path. */
  async mutateState(mutator) {
    return this.locks.withLocks(['state'], async () => {
      const state = await this.loadState();
      await mutator(state);
      await this.saveState(state);
      return state;
    });
  }

  /**
   * Monotonic sequence shared by events.jsonl and messages.jsonl so merged
   * activity feeds keep a stable order for equal timestamps.
   */
  async nextSequence() {
    let value = 0;
    await this.mutateState((state) => {
      state.log_sequence = (state.log_sequence ?? 0) + 1;
      value = state.log_sequence;
    });
    return value;
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

  /**
   * Read complete newline-terminated JSONL records starting at byte offset.
   * A trailing partial line (mid-write) is not returned. Alongside each
   * entry the end byte offset is reported so stream consumers can emit
   * per-record cursors; `offset` is the resume point for the next read.
   */
  async readJsonl(fileName, { startOffset = 0 } = {}) {
    const filePath = path.join(this.paths().logs, fileName);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], entryOffsets: [], offset: startOffset, size: startOffset };
      throw error;
    }
    if (stat.size <= startOffset) return { entries: [], entryOffsets: [], offset: startOffset, size: stat.size };

    const handle = await fs.open(filePath, 'r');
    try {
      const length = stat.size - startOffset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, startOffset);
      const text = buffer.toString('utf8');
      const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      const entries = [];
      const entryOffsets = [];
      let consumed = 0;
      for (const line of complete.split('\n')) {
        if (!line) continue;
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        consumed += lineBytes;
        entries.push(parsed);
        entryOffsets.push(startOffset + consumed);
      }
      const offset = startOffset + Buffer.byteLength(complete, 'utf8');
      return { entries, entryOffsets, offset, size: stat.size };
    } finally {
      await handle.close();
    }
  }

  async readJsonlAll(fileName) {
    const { entries } = await this.readJsonl(fileName);
    return entries;
  }

  async logEvent(type, data = {}) {
    const event = {
      event_id: makeId('EVT'),
      type,
      timestamp: nowIso(),
      sequence: await this.nextSequence(),
      ...data
    };
    await this.appendJsonl('events.jsonl', event);
    return event;
  }

  async logMessage(message) {
    const entry = {
      log_id: makeId('LOG'),
      timestamp: nowIso(),
      sequence: await this.nextSequence(),
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

  commandPath(commandId) {
    return path.join(this.paths().commands, `${commandId}.json`);
  }

  conversationPath(conversationId) {
    return path.join(this.paths().conversations, `${conversationId}.json`);
  }

  idempotencyPath(key) {
    return path.join(this.paths().idempotency, `${key}.json`);
  }

  async loadTask(taskId) {
    return readJsonFile(this.taskPath(taskId));
  }

  async saveTask(task) {
    task.updated_at = nowIso();
    task.revision = (task.revision ?? 0) + 1;
    await this.writeJson(this.taskPath(task.task_id), task);
  }

  async loadItem(itemId) {
    return readJsonFile(this.itemPath(itemId));
  }

  async saveItem(item) {
    item.updated_at = nowIso();
    item.revision = (item.revision ?? 0) + 1;
    await this.writeJson(this.itemPath(item.item_id), item);
  }

  async loadApproval(approvalId) {
    return readJsonFile(this.approvalPath(approvalId));
  }

  async saveApproval(approval) {
    approval.updated_at = nowIso();
    approval.revision = (approval.revision ?? 0) + 1;
    await this.writeJson(this.approvalPath(approval.approval_id), approval);
  }

  async saveAction(action) {
    action.updated_at = nowIso();
    action.revision = (action.revision ?? 0) + 1;
    await this.writeJson(this.actionPath(action.action_id), action);
  }

  async loadAction(actionId) {
    return readJsonFile(this.actionPath(actionId));
  }

  async loadCommand(commandId) {
    return readJsonFile(this.commandPath(commandId));
  }

  async saveCommand(command) {
    command.updated_at = nowIso();
    command.revision = (command.revision ?? 0) + 1;
    await this.writeJson(this.commandPath(command.command_id), command);
  }

  async loadConversation(conversationId) {
    return readJsonFile(this.conversationPath(conversationId));
  }

  async saveConversation(conversation) {
    conversation.updated_at = nowIso();
    conversation.revision = (conversation.revision ?? 0) + 1;
    await this.writeJson(this.conversationPath(conversation.conversation_id), conversation);
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

  async listCommands() {
    return this.listJson(this.paths().commands);
  }

  async listConversations() {
    return this.listJson(this.paths().conversations);
  }

  /**
   * Locked mutation for one aggregate. Reloads the latest snapshot inside the
   * lock, verifies expectedRevision (when provided), runs the mutator, saves
   * and returns the mutated record.
   */
  async mutateTask(taskId, expectedRevision, mutator) {
    return this.locks.withLocks([`task:${taskId}`], async () => {
      const task = await this.loadTask(taskId);
      this.checkRevision(task, expectedRevision, 'task');
      await mutator(task);
      await this.saveTask(task);
      return task;
    });
  }

  async mutateApproval(approvalId, expectedRevision, mutator) {
    return this.locks.withLocks([`approval:${approvalId}`], async () => {
      const approval = await this.loadApproval(approvalId);
      this.checkRevision(approval, expectedRevision, 'approval');
      await mutator(approval);
      await this.saveApproval(approval);
      return approval;
    });
  }

  async mutateItem(itemId, expectedRevision, mutator) {
    return this.locks.withLocks([`item:${itemId}`], async () => {
      const item = await this.loadItem(itemId);
      this.checkRevision(item, expectedRevision, 'item');
      await mutator(item);
      await this.saveItem(item);
      return item;
    });
  }

  async mutateCommand(commandId, expectedRevision, mutator) {
    return this.locks.withLocks([`command:${commandId}`], async () => {
      const command = await this.loadCommand(commandId);
      this.checkRevision(command, expectedRevision, 'command');
      await mutator(command);
      await this.saveCommand(command);
      return command;
    });
  }

  async mutateAction(actionId, mutator) {
    return this.locks.withLocks([`action:${actionId}`], async () => {
      const action = await this.loadAction(actionId);
      await mutator(action);
      await this.saveAction(action);
      return action;
    });
  }

  async mutateConversation(conversationId, mutator) {
    return this.locks.withLocks([`conversation:${conversationId}`], async () => {
      const conversation = await this.loadConversation(conversationId);
      await mutator(conversation);
      await this.saveConversation(conversation);
      return conversation;
    });
  }

  /**
   * Multi-aggregate mutation under the canonical lock order:
   * task -> approval -> item -> command -> conversation -> action.
   * `targets` lists { kind, id, expectedRevision? } entries; records are
   * keyed by kind+id so the same group may include several records of one
   * kind without overwriting each other. All snapshots are saved inside one
   * lock window so related records stay consistent.
   */
  async mutateGroup(targets, mutators = {}) {
    const order = { task: 0, approval: 1, item: 2, command: 3, conversation: 4, action: 5 };
    const sorted = [...targets].sort((left, right) => order[left.kind] - order[right.kind]);
    const keys = sorted.map(({ kind, id }) => `${kind}:${id}`);
    const loaders = {
      task: (id) => this.loadTask(id),
      approval: (id) => this.loadApproval(id),
      item: (id) => this.loadItem(id),
      command: (id) => this.loadCommand(id),
      conversation: (id) => this.loadConversation(id),
      action: (id) => this.loadAction(id)
    };
    const savers = {
      task: (r) => this.saveTask(r),
      approval: (r) => this.saveApproval(r),
      item: (r) => this.saveItem(r),
      command: (r) => this.saveCommand(r),
      conversation: (r) => this.saveConversation(r),
      action: (r) => this.saveAction(r)
    };
    return this.locks.withLocks(keys, async () => {
      const loaded = new Map();
      for (const target of sorted) {
        const record = await loaders[target.kind](target.id);
        this.checkRevision(record, target.expectedRevision, target.kind);
        loaded.set(`${target.kind}:${target.id}`, record);
      }
      for (const target of sorted) {
        if (mutators[target.kind]) await mutators[target.kind](loaded.get(`${target.kind}:${target.id}`));
      }
      for (const target of sorted) {
        await savers[target.kind](loaded.get(`${target.kind}:${target.id}`));
      }
      return loaded;
    });
  }

  checkRevision(record, expectedRevision, kind) {
    if (expectedRevision === undefined || expectedRevision === null) return;
    const current = record.revision ?? 0;
    if (current !== expectedRevision) {
      const error = new Error(`${kind} revision conflict: expected ${expectedRevision}, current ${current}`);
      error.code = 'REVISION_CONFLICT';
      error.details = { expectedRevision, currentRevision: current };
      throw error;
    }
  }

  async readIdempotency(key) {
    return readOptionalJson(this.idempotencyPath(key), null);
  }

  async writeIdempotency(record) {
    await this.writeJson(this.idempotencyPath(record.key), record);
  }

  async clearIdempotency(key) {
    try {
      await fs.rm(this.idempotencyPath(key), { force: true });
    } catch { /* ignore */ }
  }

  async readRaw(fileName) {
    return readOptionalJson(path.join(this.paths().raw, fileName), null);
  }
}
