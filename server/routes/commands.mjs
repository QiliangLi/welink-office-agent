import { notFoundError } from '../middleware/error-handler.mjs';

export function register(register) {
  register('GET', '/api/v1/commands/:commandId', async ({ reply, params, context }) => {
    const command = await context.store.loadCommand(params.commandId).catch(() => null);
    if (!command) throw notFoundError('COMMAND_NOT_FOUND', '命令不存在。');
    reply(200, {
      id: command.command_id,
      type: command.type,
      aggregateType: command.aggregate_type,
      aggregateId: command.aggregate_id,
      status: command.status,
      attempts: command.attempts ?? 0,
      createdAt: command.created_at,
      updatedAt: command.updated_at,
      completedAt: command.completed_at ?? null,
      error: command.error ?? null
    });
  });
}
