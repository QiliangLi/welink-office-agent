import { createTaskSchema, taskCommandSchema, taskListQuerySchema } from '../schemas/tasks.mjs';
import { TaskReadService } from '../services/task-read-service.mjs';
import { conflictError, notFoundError } from '../middleware/error-handler.mjs';
import { allowedCommandsFor } from '../serializers/task-dto.mjs';

export function register(register, context) {
  const taskRead = context.taskReadService;

  register('GET', '/api/v1/tasks', async ({ reply, query, repeat }) => {
    const statuses = repeat('status').filter(Boolean);
    const limitRaw = query.limit ? Number(query.limit) : 20;
    const result = await taskRead.listTasks({
      q: query.q ?? '',
      statuses: statuses.length ? statuses : null,
      updatedFrom: query.updatedFrom ?? null,
      updatedTo: query.updatedTo ?? null,
      cursor: query.cursor ?? null,
      limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 100)
    });
    reply(200, result);
  }, { querySchema: taskListQuerySchema });

  register('POST', '/api/v1/tasks', async ({ reply, body, context, idempotencyKey }) => {
    const result = await context.consoleCommandService.createTaskFromConsole(
      {
        description: body.description,
        priority: body.priority,
        deadline: body.deadline ?? null,
        externalPolicy: body.externalPolicy,
        executionMode: body.executionMode,
        attachmentIds: body.attachmentIds ?? []
      },
      { idempotencyKey, requestedBy: context.ownerEmployeeNumber }
    );
    reply(202, {
      task: { id: result.task.task_id, revision: result.task.revision, displayStatus: 'queued' },
      command: { id: result.command.command_id, status: result.command.status }
    });
  }, { schema: createTaskSchema });

  register('GET', '/api/v1/tasks/:taskId', async ({ reply, params }) => {
    const detail = await taskRead.getTaskDetail(params.taskId);
    reply(200, detail);
  });

  register('GET', '/api/v1/tasks/:taskId/events', async ({ reply, params, query }) => {
    const limitRaw = query.limit ? Number(query.limit) : 30;
    const result = await taskRead.getTaskEvents(params.taskId, {
      cursor: query.cursor ?? null,
      limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 30, 1), 100)
    });
    reply(200, result);
  });

  register('POST', '/api/v1/tasks/:taskId/commands', async ({ reply, params, body, context }) => {
    const taskId = params.taskId;
    const task = await context.store.loadTask(taskId).catch(() => null);
    if (!task) throw notFoundError('TASK_NOT_FOUND', '任务不存在或已被删除。');
    const allowed = allowedCommandsFor(task);
    if (!allowed.includes(body.type)) {
      throw conflictError('INVALID_STATE_TRANSITION', `任务当前状态不允许执行 ${body.type}。`, { allowedCommands: allowed });
    }
    const result = await context.consoleCommandService.applyTaskCommand(taskId, {
      type: body.type,
      expectedRevision: body.expectedRevision,
      text: body.text ?? null
    });
    if (result.immediate) {
      reply(200, {
        task: { id: result.task.task_id, revision: result.task.revision, sourceStatus: result.task.status },
        command: null
      });
      return;
    }
    reply(202, {
      task: { id: result.task.task_id, revision: result.task.revision, sourceStatus: result.task.status },
      command: { id: result.commandId, status: 'queued' }
    });
  }, { schema: taskCommandSchema });

  register('POST', '/api/v1/tasks/:taskId/subtasks/:subtaskId/reminders', async ({ reply, params, context }) => {
    const result = await context.consoleCommandService.requestReminder(params.taskId, params.subtaskId, {
      requestedBy: context.ownerEmployeeNumber
    });
    reply(202, { command: { id: result.commandId, status: 'queued' } });
  }, { schema: { type: 'object', properties: {} } });
}
