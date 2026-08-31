/**
 * Contacts config management shared by the Console API and the CLI. The
 * contacts.json map is keyed by employee number; unknown fields (including
 * w3account and expertise) are preserved on write and never exposed by
 * serializeContactConfig — the browser only ever sees display-safe fields
 * (docs/frontend-backend-integration.md §11.2).
 */

const EMPLOYEE_NUMBER_PATTERN = /^\d{4,16}$/;

export function isValidEmployeeNumber(value) {
  return typeof value === 'string' && EMPLOYEE_NUMBER_PATTERN.test(value);
}

function initialsOf(name) {
  const text = String(name ?? '').replace(/\s+/g, '').trim();
  return text ? text.slice(0, 2).toUpperCase() : '??';
}

export function serializeContactConfig(employeeNumber, entry) {
  const safe = entry ?? {};
  return {
    employeeNumber,
    name: typeof safe.name === 'string' && safe.name.trim() ? safe.name.trim() : '未命名联系人',
    address: typeof safe.address === 'string' ? safe.address : null,
    department: typeof safe.department === 'string' ? safe.department : null,
    avatarInitials: typeof safe.avatar_initials === 'string' && safe.avatar_initials ? safe.avatar_initials : initialsOf(safe.name),
    expertise: Array.isArray(safe.expertise) ? safe.expertise.filter((item) => typeof item === 'string') : [],
    autoContact: safe.auto_contact === true,
    autoReply: safe.auto_reply === true
  };
}

export async function listContacts(store) {
  const config = await store.loadConfig('contacts').catch(() => ({}));
  return Object.entries(config)
    .filter(([employeeNumber]) => isValidEmployeeNumber(employeeNumber))
    .map(([employeeNumber, entry]) => serializeContactConfig(employeeNumber, entry))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.employeeNumber.localeCompare(right.employeeNumber));
}

export async function upsertContact(store, input) {
  if (!isValidEmployeeNumber(input.employeeNumber)) {
    const error = new Error('员工号必须是 4 到 16 位数字。');
    error.code = 'CONTACT_PAYLOAD_INVALID';
    throw error;
  }
  const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 32) {
    const error = new Error('联系人姓名不能为空，且不超过 32 个字符。');
    error.code = 'CONTACT_PAYLOAD_INVALID';
    throw error;
  }
  await store.mutateConfig('contacts', (config) => {
    const existing = config[input.employeeNumber] ?? {};
    config[input.employeeNumber] = {
      ...existing,
      name,
      address: input.address ?? existing.address ?? null,
      department: input.department ?? existing.department ?? null,
      auto_contact: input.autoContact === true
    };
  });
  const config = await store.loadConfig('contacts');
  return serializeContactConfig(input.employeeNumber, config[input.employeeNumber]);
}

export async function removeContact(store, employeeNumber) {
  if (!isValidEmployeeNumber(employeeNumber)) {
    const error = new Error('员工号必须是 4 到 16 位数字。');
    error.code = 'CONTACT_PAYLOAD_INVALID';
    throw error;
  }
  let removed = false;
  await store.mutateConfig('contacts', (config) => {
    removed = Boolean(config[employeeNumber]);
    delete config[employeeNumber];
  });
  return removed;
}
