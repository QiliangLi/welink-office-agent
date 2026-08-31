import { contactCommandSchema } from '../schemas/contacts.mjs';
import { validationError } from '../middleware/error-handler.mjs';
import { listContacts, upsertContact, removeContact } from '../../scripts/lib/contacts-service.mjs';

/**
 * Contacts whitelist management. Reads return display-safe fields only
 * (w3account never crosses the API, docs §11.2); writes are deterministic
 * config mutations under the config lock, so they run directly instead of
 * queueing a command for tick.
 */
export function register(register, context) {
  register('GET', '/api/v1/contacts', async ({ reply, context: ctx }) => {
    const items = await listContacts(ctx.store);
    reply(200, { items, snapshotAt: new Date().toISOString() });
  });

  register('POST', '/api/v1/contacts/commands', async ({ reply, body }) => {
    if (body.type === 'upsert' && !body.name) {
      throw validationError('新增或更新联系人时姓名不能为空。', { field: 'name' });
    }
    if (body.type === 'upsert') {
      const contact = await upsertContact(context.store, {
        employeeNumber: body.employeeNumber,
        name: body.name,
        // Pass through untouched so undefined (keep stored value) survives
        // alongside null (clear the stored value).
        department: body.department,
        address: body.address,
        autoContact: body.autoContact ?? false
      });
      reply(200, { contact });
      return;
    }
    const removed = await removeContact(context.store, body.employeeNumber);
    reply(200, { removed });
  }, { schema: contactCommandSchema });
}
