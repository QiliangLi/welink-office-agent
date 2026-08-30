import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

export function boolArg(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

export function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text);
}

export async function readOptionalJson(filePath, fallback = null) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function projectRootFromScript(importMetaUrl) {
  const currentFile = fileURLToPath(importMetaUrl);
  return path.resolve(path.dirname(currentFile), '..');
}

export function jsonOutput(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function nowIso() {
  return new Date().toISOString();
}

export function compactText(value, maxLength = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
