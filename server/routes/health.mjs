import { buildHealth } from '../services/health-service.mjs';
import { initialsOf } from '../serializers/task-dto.mjs';

export function register(register, context) {
  register('GET', '/api/v1/health', async ({ reply, context: ctx }) => {
    const health = await buildHealth(ctx.store);
    reply(200, { ...health });
  });

  register('GET', '/api/v1/session', async ({ reply, context: ctx }) => {
    const ownerNumber = ctx.ownerConfig.owner_employee_number ?? null;
    const contact = ownerNumber ? ctx.contactsConfig?.[ownerNumber] : null;
    const name = contact?.name ?? 'Owner';
    reply(200, {
      owner: {
        employeeNumber: ownerNumber,
        name,
        initials: contact?.avatar_initials ?? initialsOf(name)
      },
      timezone: ctx.ownerConfig.timezone ?? 'Asia/Shanghai',
      mode: ctx.mode,
      csrfToken: ctx.csrfToken
    });
  });
}
