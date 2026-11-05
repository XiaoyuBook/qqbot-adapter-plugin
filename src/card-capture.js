import fs from 'node:fs/promises';
import path from 'node:path';
import { pluginRoot } from './config.js';

// Explicit local opt-in: one card, at most five minutes, no routing identities.
// Nothing is captured unless an operator creates a short-lived request file.
export async function captureIncomingCard(message, content, { directory = path.join(pluginRoot, '.verification-cache'), now = Date.now } = {}) {
  const cards = message.filter(part => part.type === 'json' && typeof part.data === 'string').slice(0, 2).map(part => part.data);
  if (!cards.length || cards.some(data => data.length > 64000) || typeof content !== 'string' || content.length > 64000) return false;
  try {
    const request = path.join(directory, 'card-diagnostic-request.json');
    const stat = await fs.lstat(request);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
    const { requestedAt, expiresAt } = JSON.parse(await fs.readFile(request, 'utf8'));
    const time = now();
    if (!Number.isSafeInteger(requestedAt) || !Number.isSafeInteger(expiresAt) || requestedAt > time || expiresAt <= time || expiresAt <= requestedAt || expiresAt - requestedAt > 300000) return false;
    const snapshot = JSON.stringify({ capturedAt: time, content, cards: cards.map(data => JSON.parse(data)) });
    if (Buffer.byteLength(snapshot) > 512000) return false;
    // Exclusive creation also refuses symlinks and prevents a later card from
    // replacing the requested sample. The file is never included in logs.
    await fs.writeFile(path.join(directory, 'card-diagnostic-result.json'), snapshot, { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; }
}
