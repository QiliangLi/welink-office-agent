import crypto from 'node:crypto';

function datePart() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function makeId(prefix) {
  return `${prefix}-${datePart()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}
