import fs from 'node:fs/promises';
import path from 'node:path';
import { pluginRoot } from './config.js';

// Explicit local opt-in: one pre-mapping card event, at most one day.
// The complete envelope stays in a private file and is never included in logs.
const MAX_CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CAPTURE_BYTES = 1048576;
const messageEvents = new Set(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE']);

function containsCard(value, budget = { nodes: 0 }, depth = 0) {
  if (!value || typeof value !== 'object' || ++budget.nodes > 100 || depth > 8) return false;
  if ([102, 103].includes(value.message_type)) return false;
  if (value.message_type === 3 || value.ark_data !== undefined || value.type === 'json' || value.type === 'ark') return true;
  if (Array.isArray(value.embeds) && value.embeds.length) return true;
  for (const children of [value.msg_elements, value.message, value.parallel_message?.msg_nodes]) {
    if (!Array.isArray(children)) continue;
    for (const child of children) if (containsCard(child, budget, depth + 1)) return true;
  }
  return false;
}

export async function captureIncomingCard(payload, { directory = path.join(pluginRoot, '.verification-cache'), now = Date.now } = {}) {
  try {
    if (!messageEvents.has(payload?.t) || payload.d?.author?.bot === true || !containsCard(payload.d)) return false;
    // Copy before the first await: downstream mappers and consumers may mutate
    // their event objects. Unknown provider fields must remain inspectable.
    const time = now();
    const snapshot = JSON.stringify({ schemaVersion: 2, capturedAt: time, stage: 'gateway-before-mapping', payload });
    if (Buffer.byteLength(snapshot) > MAX_CAPTURE_BYTES) return false;
    const request = path.join(directory, 'card-diagnostic-request.json');
    const stat = await fs.lstat(request);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
    const { mode, requestedAt, expiresAt } = JSON.parse(await fs.readFile(request, 'utf8'));
    if (mode !== 'gateway-card' || !Number.isSafeInteger(requestedAt) || !Number.isSafeInteger(expiresAt) || requestedAt > time || expiresAt <= time || expiresAt <= requestedAt || expiresAt - requestedAt > MAX_CAPTURE_WINDOW_MS) return false;
    // Exclusive creation refuses existing files and symlinks, so concurrent
    // messages cannot replace the requested sample. Successful capture disarms.
    await fs.writeFile(path.join(directory, 'card-diagnostic-result.json'), snapshot, { flag: 'wx', mode: 0o600 });
    await fs.unlink(request).catch(() => {});
    return true;
  } catch { return false; }
}
