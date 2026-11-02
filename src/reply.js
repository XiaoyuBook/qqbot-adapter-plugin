import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { AdapterError, logFailure, safeError } from './errors.js';

function imageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'localhost' || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error();
    return url.href;
  } catch { throw new AdapterError('IMAGE_INVALID'); }
}

export async function imageSource(value, maxBytes) {
  if (typeof value === 'string' && /^https?:/i.test(value)) return { url: imageUrl(value) };
  let data;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) data = Buffer.from(value);
  else if (typeof value === 'string' && value.startsWith('base64://')) {
    const encoded = value.slice(9);
    if (encoded.length > Math.ceil(maxBytes / 3) * 4) throw new AdapterError('IMAGE_TOO_LARGE');
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdapterError('IMAGE_INVALID');
    data = Buffer.from(encoded, 'base64');
  } else if (typeof value === 'string' && value && !value.includes('\0')) {
    try {
      const filename = value.startsWith('file:') ? fileURLToPath(value) : value;
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AdapterError('IMAGE_INVALID');
      if (stat.size > maxBytes) throw new AdapterError('IMAGE_TOO_LARGE');
      data = await fs.readFile(filename);
    } catch (error) { throw error instanceof AdapterError ? error : new AdapterError('IMAGE_INVALID'); }
  } else throw new AdapterError('IMAGE_INVALID');
  if (data.length > maxBytes) throw new AdapterError('IMAGE_TOO_LARGE');
  // Avoid treating arbitrary local files, including private JSON, as image uploads.
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!png && !jpeg) throw new AdapterError('IMAGE_INVALID');
  return { file_data: data.toString('base64') };
}

async function messageParts(message, config) {
  const input = Array.isArray(message) ? message : [message];
  const parts = [];
  for (const item of input) {
    let text;
    if (typeof item === 'string') text = item;
    else if (item?.type === 'text' && typeof item.text === 'string') text = item.text;
    else if (Buffer.isBuffer(item) || item instanceof Uint8Array || item?.type === 'image') {
      parts.push({ image: await imageSource(item?.type === 'image' ? (item.file ?? item.url) : item, config.maxImageBytes) });
      continue;
    } else throw new AdapterError('UNSUPPORTED_MESSAGE');
    if (!text) continue;
    const previous = parts.at(-1);
    if (previous?.text !== undefined) previous.text += text;
    else parts.push({ text });
  }
  const output = [];
  for (const part of parts) {
    if (part.image) output.push(part);
    else {
      const chars = Array.from(part.text);
      for (let i = 0; i < chars.length; i += 1500) output.push({ text: chars.slice(i, i + 1500).join('') });
    }
  }
  if (!output.length) throw new AdapterError('UNSUPPORTED_MESSAGE');
  return output;
}

function validateOptions(quote, extra) {
  if (quote || (extra !== undefined && (extra === null || typeof extra !== 'object' || Object.keys(extra).length))) throw new AdapterError('UNSUPPORTED_OPTIONS');
}

export class PassiveReply {
  constructor({ api, config, scope, target, messageId, createdAt, online = () => true, logger, now = Date.now, onError = () => {} }) {
    Object.assign(this, { api, config, scope, target, messageId, createdAt, online, logger, now, onError });
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.feedbackSent = false;
  }
  #check() {
    if (!this.online()) throw new AdapterError('OFFLINE');
    if (!this.messageId) throw new AdapterError('PASSIVE_ONLY');
    if (this.now() - this.createdAt > this.config.replyWindowSeconds * 1000) throw new AdapterError('REPLY_EXPIRED');
    if (this.sequence >= this.config.maxReplies) throw new AdapterError('REPLY_LIMIT');
  }
  async #post(body) {
    this.#check();
    const result = await this.api.request('POST', this.api.route(this.scope, this.target, 'messages'), { ...body, msg_id: this.messageId, msg_seq: ++this.sequence });
    if (typeof result.id !== 'string' || !result.id) throw new AdapterError('API_RESPONSE');
    return { message_id: result.id, seq: this.sequence, time: result.timestamp };
  }
  #enqueue(callback) {
    const pending = this.queue.then(callback);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async #failure(error) {
    const safe = safeError(error);
    this.onError({ code: safe.code, message: safe.message, ...(safe.status ? { status: safe.status } : {}), ...(safe.platformCode ? { platformCode: safe.platformCode } : {}) });
    logFailure(this.logger, 'reply', safe);
    // Only local validation errors get one passive explanation. Never resend on a
    // timeout/unknown delivery result or amplify a platform rejection.
    if (!this.feedbackSent && /^(UNSUPPORTED_|IMAGE_)/.test(safe.code)) {
      this.feedbackSent = true;
      try { await this.#post({ msg_type: 0, content: `[QQBot] ${safe.message}` }); }
      catch (feedbackError) { logFailure(this.logger, 'feedback', feedbackError); }
    }
    return false;
  }
  fail(error) { return this.#enqueue(() => this.#failure(error)); }
  send(message, quote = false, extra) {
    return this.#enqueue(async () => {
      try {
        this.#check();
        validateOptions(quote, extra);
        const parts = await messageParts(message, this.config);
        if (this.sequence + parts.length > this.config.maxReplies) throw new AdapterError('REPLY_LIMIT');
        const sent = [];
        for (const part of parts) {
          if (part.image) {
            this.#check();
            const upload = await this.api.request('POST', this.api.route(this.scope, this.target, 'files'), { file_type: 1, srv_send_msg: false, ...part.image });
            if (typeof upload.file_info !== 'string' || !upload.file_info) throw new AdapterError('API_RESPONSE');
            sent.push(await this.#post({ msg_type: 7, content: ' ', media: { file_info: upload.file_info } }));
          } else sent.push(await this.#post({ msg_type: 0, content: part.text }));
        }
        return { ...sent.at(-1), message_ids: sent.map(item => item.message_id) };
      } catch (error) { return this.#failure(error); }
    });
  }
}

// Miao wraps e.reply and drops its third argument. Check options before that
// wrapper runs, so buttons/recall/@ options cannot silently turn into success.
export function installReply(event, reply) {
  const guard = fn => (message, quote = false, extra) => {
    try { validateOptions(quote, extra); }
    catch (error) { return reply.fail(error); }
    return fn(message, quote, extra);
  };
  let current = guard((...args) => reply.send(...args));
  Object.defineProperty(event, 'reply', {
    enumerable: true, configurable: false,
    get: () => current,
    set: fn => { if (typeof fn === 'function') current = guard(fn); }
  });
}
