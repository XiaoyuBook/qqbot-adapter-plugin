import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { AdapterError, logFailure, safeError } from './errors.js';
import { uploadMedia } from './media.js';
import { keyboardText } from './rich.js';
import { messageParts, escapeMarkdown } from './message-plan.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sendReceipt } from './receipts.js';

const optionContext = new AsyncLocalStorage();

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

function validateOptions(quote, extra) {
  if (quote !== undefined && quote !== null && typeof quote !== 'boolean' && (!quote || typeof quote !== 'object' || Array.isArray(quote) || !Object.keys(quote).some(key => ['message_id', 'id', 'ref_idx'].includes(key)))) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra !== undefined && (extra === null || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).some(key => !['recallMsg', 'at', 'button', 'keyboard', 'receipt'].includes(key)))) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.recallMsg !== undefined && (!Number.isInteger(extra.recallMsg) || extra.recallMsg < 0 || extra.recallMsg > 120)) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.at !== undefined && typeof extra.at !== 'boolean' && typeof extra.at !== 'string' && !(Number.isSafeInteger(extra.at) && extra.at > 0)) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.button !== undefined && extra?.keyboard !== undefined) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.receipt !== undefined && typeof extra.receipt !== 'boolean') throw new AdapterError('UNSUPPORTED_OPTIONS');
}

export class PassiveReply {
  constructor({ api, config, registry, scope, target, senderId, messageId, eventId, referenceId, proactive = false, createdAt, online = () => true, logger, now = Date.now, onError = () => {}, onCompatibility = () => {} }) {
    Object.assign(this, { api, config, registry, scope, target, senderId, messageId, eventId, referenceId, proactive, createdAt, online, logger, now, onError, onCompatibility });
    this.limit = Math.min(config.maxReplies, proactive ? 5 : scope === 'c2c' ? 4 : 5);
    this.windowSeconds = scope === 'c2c' ? config.c2cReplyWindowSeconds ?? config.replyWindowSeconds : config.replyWindowSeconds;
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.feedbackSent = false;
    this.warnings = new Set();
    this.lastReceipt = null;
  }
  warn(code) { this.warnings.add(code); this.onCompatibility(code); }
  #check() {
    if (!this.online()) throw new AdapterError('OFFLINE');
    if (!this.messageId && !this.eventId && !this.proactive) throw new AdapterError('PASSIVE_ONLY');
    if (!this.proactive && this.now() - this.createdAt > this.windowSeconds * 1000) throw new AdapterError('REPLY_EXPIRED');
    if (this.sequence >= this.limit) throw new AdapterError('REPLY_LIMIT');
  }
  async #post(body, recallSeconds = 0) {
    this.#check();
    if (body.keyboard && this.registry?.keyboardUnavailable) return this.#post(this.keyboardFallback(body), recallSeconds);
    ++this.sequence;
    let result;
    try {
      result = await this.api.request('POST', this.api.route(this.scope, this.target, 'messages'), { ...body, ...(!this.proactive ? { ...(this.messageId ? { msg_id: this.messageId } : { event_id: this.eventId }), msg_seq: this.sequence } : {}) });
    } catch (error) {
      // 304037 is an explicit no-button-permission rejection, never a delivery
      // timeout. Reuse that rejected sequence for a readable, button-free reply.
      if (body.keyboard && error instanceof AdapterError && error.code === 'PERMISSION_REQUIRED' && error.platformCode === 304037) {
        --this.sequence;
        if (this.registry) this.registry.keyboardUnavailable = true;
        return this.#post(this.keyboardFallback(body), recallSeconds);
      }
      throw error;
    }
    if (typeof result.id !== 'string' || !result.id) throw new AdapterError('API_RESPONSE');
    this.registry?.rememberMessage(this.scope, this.target, result.id, { own: true, ref_idx: result.ext_info?.ref_idx });
    if (recallSeconds) this.registry.scheduleRecall(this.scope, this.target, result.id, recallSeconds);
    return { message_id: result.id, seq: this.sequence, time: result.timestamp, ...(result.ext_info?.ref_idx ? { ref_idx: result.ext_info.ref_idx } : {}) };
  }
  keyboardFallback(body) {
    this.warn('keyboard_unavailable_text_fallback');
    const instructions = escapeMarkdown(keyboardText(body.keyboard));
    const result = { ...body, markdown: { content: `${body.markdown?.content ?? ''}\n\n${instructions}` } };
    delete result.keyboard; delete result.content;
    return result;
  }
  #enqueue(callback) {
    const pending = this.queue.then(callback);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async #failure(error, feedback = true, { sent = [], total = 0, stage = 'validation', detailed = false } = {}) {
    const safe = safeError(error);
    this.lastReceipt = sendReceipt(sent, { total, error: safe, stage, warnings: [...this.warnings] });
    this.onError({ code: safe.code, message: safe.message, ...(safe.status ? { status: safe.status } : {}), ...(safe.platformCode ? { platformCode: safe.platformCode } : {}) });
    logFailure(this.logger, 'reply', safe);
    // Only local validation errors get one passive explanation. Never resend on a
    // timeout/unknown delivery result or amplify a platform rejection.
    if (feedback && !this.feedbackSent && /^(UNSUPPORTED_|IMAGE_|MEDIA_|FORWARD_|OPERATION_INVALID|MESSAGE_UNKNOWN)/.test(safe.code)) {
      this.feedbackSent = true;
      try { await this.#post({ msg_type: 0, content: `[QQBot] ${safe.message}` }); }
      catch (feedbackError) { logFailure(this.logger, 'feedback', feedbackError); }
    }
    // Preserve the historical false result when nothing was delivered. A
    // partial result always retains the successful IDs for recall/accounting.
    return detailed || sent.length ? this.lastReceipt : false;
  }
  fail(error, feedback = true, detailed = false) { return this.#enqueue(() => { this.warnings.clear(); return this.#failure(error, feedback, { detailed }); }); }
  reference(quote) {
    if (!quote) return undefined;
    let id;
    if (quote === true) id = this.referenceId;
    else if (typeof quote.ref_idx === 'string') id = quote.ref_idx;
    else {
      const messageId = quote.message_id ?? quote.id;
      const known = this.registry?.message(this.scope, this.target, messageId);
      id = messageId === this.messageId ? this.referenceId : known?.recalled ? undefined : known?.ref_idx;
    }
    if (typeof id === 'string' && id && id.length <= 2048 && !/[\0\r\n]/.test(id)) return { message_id: id };
    if (quote === true) { this.warn('quote_display_unavailable'); return undefined; }
    throw new AdapterError('MESSAGE_UNKNOWN');
  }
  send(message, quote = false, extra) {
    return this.#enqueue(async () => {
      const sent = [];
      let total = 0, stage = 'validation';
      this.warnings.clear();
      try {
        this.#check();
        validateOptions(quote, extra);
        if (extra?.recallMsg && !this.registry) throw new AdapterError('UNSUPPORTED_OPTIONS');
        const context = { scope: this.scope, registry: this.registry, senderId: this.senderId, target: this.target, warn: code => this.warn(code), extra, quote,
          imageMention: this.config.mentionBeforeImage && this.scope === 'group' && !this.proactive && this.senderId && extra?.at !== false };
        const parts = await messageParts(message, this.config, context);
        total = parts.length;
        const reference = this.reference(context.quote);
        if (this.sequence + parts.length > this.limit) throw new AdapterError('REPLY_LIMIT');
        const post = body => { stage = 'message'; return this.#post(reference ? { ...body, message_reference: reference } : body, extra?.recallMsg); };
        for (const part of parts) {
          stage = 'validation';
          let body;
          if (part.media) {
            this.#check();
            if (part.image) {
              const { dimensions, prefix, caption } = part.image;
              stage = 'upload';
              sent.push(await this.registry.imageReplies.send(part.media, async url => {
                this.#check();
                const image = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
                return post({ msg_type: 2, markdown: { content: prefix + '\n' + (caption ? caption + '\n' : '') + '![图片 #' + dimensions.width + 'px #' + dimensions.height + 'px](' + image + ')', force_verify_image_resource: true } });
              }));
              continue;
            }
            stage = 'upload';
            const upload = await uploadMedia(this.api, this.scope, this.target, part.media, () => this.#check());
            if (typeof upload.file_info !== 'string' || !upload.file_info) throw new AdapterError('API_RESPONSE');
            body = { msg_type: 7, content: part.text || ' ', media: { file_info: upload.file_info } };
          } else body = part.body ?? { msg_type: 0, content: part.text };
          sent.push(await post(body));
        }
        this.lastReceipt = sendReceipt(sent, { total, warnings: [...this.warnings] });
        return this.lastReceipt;
      } catch (error) { return this.#failure(error, true, { sent, total, stage, detailed: extra?.receipt === true }); }
    });
  }
}

// Inherit only while delegating through this event's reply wrapper chain.
// Empty objects and omitted fields preserve inherited options; explicit values
// (including false and 0) override them. Direct contact sends stay independent.
function replyOptions(reply, extra) {
  const inherited = optionContext.getStore();
  const base = inherited?.reply === reply ? inherited.extra : undefined;
  if (base === undefined && extra === undefined) return undefined;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) if (value !== undefined) {
    if (key === 'button') delete result.keyboard;
    if (key === 'keyboard') delete result.button;
    result[key] = value;
  }
  return result;
}

export function installReply(event, reply) {
  if (event.qqbot) Object.defineProperty(event.qqbot, 'lastReceipt', { enumerable: true, get: () => reply.lastReceipt });
  const guard = (fn, host = false) => (message, quote = false, extra) => {
    let effective;
    try { validateOptions(quote, extra); effective = replyOptions(reply, extra); validateOptions(quote, effective); }
    catch (error) {
      const inherited = optionContext.getStore();
      const detailed = extra?.receipt ?? (inherited?.reply === reply ? inherited.extra?.receipt : undefined);
      return reply.fail(error, true, detailed === true);
    }
    return optionContext.run({ reply, extra: effective }, () => host ? fn(message, quote) : fn(message, quote, effective));
  };
  let current = guard((...args) => reply.send(...args));
  Object.defineProperty(event, 'reply', {
    enumerable: true, configurable: false,
    get: () => current,
    set: fn => {
      if (typeof fn !== 'function') return;
      // The Miao Loader hands off the previous function via replyNew. Only
      // that boundary must avoid the host's duplicate @ and recall processing.
      current = guard(fn, event.replyNew === current);
    }
  });
}
