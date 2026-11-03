import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { AdapterError, logFailure, safeError } from './errors.js';
import { isForwardMessage, forwardContent } from './forward.js';
import { prepareMedia, uploadMedia } from './media.js';
import { markdown, keyboard, card, keyboardText, isLegacyButton } from './rich.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const optionContext = new AsyncLocalStorage();
const escapeMarkdown = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!~|])/g, '\\$1');

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

async function messageParts(message, config, context) {
  let input = Array.isArray(message) ? message : [message];
  input = input.flatMap(item => {
    if (!isForwardMessage(item)) return [item];
    const forward = forwardContent(item);
    forward.warnings.forEach(context.warn);
    return forward.items;
  });
  if (input.length > 1000) throw new AdapterError('UNSUPPORTED_MESSAGE');
  const media = item => Buffer.isBuffer(item) || item instanceof Uint8Array || ['image', 'record', 'audio', 'video', 'file', 'media'].includes(item?.type);
  const whitespace = item => typeof item === 'string' ? !item.trim() : item?.type === 'text' && typeof item.text === 'string' && !item.text.trim();
  // Old plugins append navigation to every chart. Keep meaningful prompts and
  // explicit native keyboards, but do not create a second bubble for that bar.
  if (input.some(isLegacyButton) && input.some(media) && input.every(item => media(item) || whitespace(item) || isLegacyButton(item) || ['at', 'reply'].includes(item?.type))) {
    input = input.filter(item => !isLegacyButton(item) && !whitespace(item));
    context.warn('legacy_navigation_omitted');
  }
  const parts = [];
  let buttons = context.extra?.keyboard ?? context.extra?.button;
  if (context.extra?.at) input = [{ type: 'at', qq: context.extra.at === true ? context.senderId : context.extra.at }, ...input];
  let text = '', richText = '', rich = false;
  function flush() {
    if (!text && !richText) return;
    if (rich) parts.push({ body: { msg_type: 2, markdown: markdown(richText) } });
    else {
      const chars = Array.from(text);
      for (let index = 0; index < chars.length; index += 1500) parts.push({ text: chars.slice(index, index + 1500).join('') });
    }
    text = ''; richText = ''; rich = false;
  }
  function append(value) { text += value; richText += escapeMarkdown(value); }
  for (const item of input) {
    if (typeof item === 'string') append(item);
    else if (item?.type === 'text' && typeof item.text === 'string') append(item.text);
    else if (item?.type === 'at' && context.senderId && String(item.id ?? item.qq) === context.senderId) {
      // The passive response is already bound to this sender's trigger. Old QR
      // plugins add the same @ marker in both group chat and private chat.
      context.warn(`${context.scope === 'group' ? 'group' : 'private'}_self_mention_omitted`);
      continue;
    } else if (item?.type === 'at') {
      if (context.scope !== 'group') throw new AdapterError('UNSUPPORTED_MESSAGE');
      context.explicitMention = true;
      const id = item.id ?? item.qq;
      if (id === 'all') richText += '<qqbot-at-everyone />';
      else {
        const openid = item.openid !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(item.openid) ? item.openid : context.registry?.openid(id, 'group-user');
        if (!openid) throw new AdapterError('UNSUPPORTED_MESSAGE');
        richText += `<qqbot-at-user id="${openid}" />`;
      }
      rich = true;
    } else if (Buffer.isBuffer(item) || item instanceof Uint8Array || ['image', 'record', 'audio', 'video', 'file'].includes(item?.type)) {
      flush(); const kind = item?.type === 'audio' ? 'record' : item?.type ?? 'image';
      parts.push({ media: await prepareMedia(kind, item?.type ? (item.file ?? item.url) : item, config, item?.name) });
    } else if (item?.type === 'media' && typeof item.file_info === 'string' && item.file_info && item.file_info.length <= 65536) {
      flush(); parts.push({ body: { msg_type: 7, media: { file_info: item.file_info }, content: ' ' } });
    } else if (item?.type === 'markdown') {
      flush(); parts.push({ body: { msg_type: 2, markdown: markdown(item.data ?? item.content) } });
    } else if (item?.type === 'button' || item?.type === 'keyboard') {
      if (buttons !== undefined) throw new AdapterError('UNSUPPORTED_OPTIONS');
      buttons = item.data;
    } else if (item?.type === 'card') { flush(); parts.push({ body: { msg_type: 8, card: card(item.data ?? item.card) } }); }
    else if (item?.type === 'reply') {
      if (context.quote !== false && context.quote !== undefined) throw new AdapterError('UNSUPPORTED_OPTIONS');
      context.quote = { message_id: item.id };
    } else throw new AdapterError('UNSUPPORTED_MESSAGE');
  }
  flush();
  // A caption and the following image are one QQ media message. This also
  // avoids consuming two of the platform's five passive replies for one QR.
  const combined = [];
  for (const part of parts) {
    if (part.media && combined.at(-1)?.text !== undefined && !combined.at(-1)?.media) combined.push({ ...part, text: combined.pop().text });
    else combined.push(part);
  }
  if (buttons !== undefined) {
    const native = keyboard(buttons, context.scope), last = combined.at(-1);
    if (last?.text !== undefined && !last.media) { last.body = { msg_type: 2, markdown: markdown(escapeMarkdown(last.text.trim()) || '请选择操作'), keyboard: native }; delete last.text; }
    else if (last?.body?.msg_type === 2) last.body.keyboard = native;
    else combined.push({ body: { msg_type: 2, markdown: markdown('请选择操作'), keyboard: native } });
  }
  if (context.imageMention && !context.explicitMention) for (const part of combined) if (part.media?.fileType === 1) part.mentionFirst = true;
  if (!combined.length) throw new AdapterError('UNSUPPORTED_MESSAGE');
  return combined;
}

function validateOptions(quote, extra) {
  if (quote !== undefined && quote !== null && typeof quote !== 'boolean' && (!quote || typeof quote !== 'object' || Array.isArray(quote) || !Object.keys(quote).some(key => ['message_id', 'id', 'ref_idx'].includes(key)))) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra !== undefined && (extra === null || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).some(key => !['recallMsg', 'at', 'button', 'keyboard'].includes(key)))) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.recallMsg !== undefined && (!Number.isInteger(extra.recallMsg) || extra.recallMsg < 0 || extra.recallMsg > 120)) throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.at !== undefined && typeof extra.at !== 'boolean' && typeof extra.at !== 'string') throw new AdapterError('UNSUPPORTED_OPTIONS');
  if (extra?.button !== undefined && extra?.keyboard !== undefined) throw new AdapterError('UNSUPPORTED_OPTIONS');
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
  async #failure(error, feedback = true) {
    const safe = safeError(error);
    this.onError({ code: safe.code, message: safe.message, ...(safe.status ? { status: safe.status } : {}), ...(safe.platformCode ? { platformCode: safe.platformCode } : {}) });
    logFailure(this.logger, 'reply', safe);
    // Only local validation errors get one passive explanation. Never resend on a
    // timeout/unknown delivery result or amplify a platform rejection.
    if (feedback && !this.feedbackSent && /^(UNSUPPORTED_|IMAGE_|MEDIA_|FORWARD_|OPERATION_INVALID|MESSAGE_UNKNOWN)/.test(safe.code)) {
      this.feedbackSent = true;
      try { await this.#post({ msg_type: 0, content: `[QQBot] ${safe.message}` }); }
      catch (feedbackError) { logFailure(this.logger, 'feedback', feedbackError); }
    }
    return false;
  }
  fail(error, feedback = true) { return this.#enqueue(() => this.#failure(error, feedback)); }
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
    extra ??= optionContext.getStore()?.reply === this ? optionContext.getStore().extra : undefined;
    return this.#enqueue(async () => {
      try {
        this.#check();
        validateOptions(quote, extra);
        if (extra?.recallMsg && !this.registry) throw new AdapterError('UNSUPPORTED_OPTIONS');
        const context = { scope: this.scope, registry: this.registry, senderId: this.senderId, warn: code => this.warn(code), extra, quote,
          imageMention: this.config.mentionBeforeImage && this.scope === 'group' && !this.proactive && this.senderId && extra?.at !== false };
        const parts = await messageParts(message, this.config, context);
        const reference = this.reference(context.quote);
        if (this.sequence + parts.length > this.limit) throw new AdapterError('REPLY_LIMIT');
        const sent = [];
        const post = body => this.#post(reference ? { ...body, message_reference: reference } : body, extra?.recallMsg);
        for (const part of parts) {
          let body;
          if (part.media) {
            this.#check();
            if (part.mentionFirst && this.registry?.imageReplies && (part.media.url || (part.media.size <= 10 * 1024 * 1024 && ['png', 'jpg', 'gif', 'webp'].includes(part.media.extension)))) {
              const id = this.registry.openid(this.senderId, 'group-user');
              const caption = escapeMarkdown((part.text || '').trim());
              sent.push(await this.registry.imageReplies.send(part.media, async url => {
                this.#check();
                const image = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
                return post({ msg_type: 2, markdown: { content: `<qqbot-at-user id="${id}" />\n${caption ? caption + '\n' : ''}![图片](${image})`, force_verify_image_resource: true } });
              }));
              continue;
            }
            if (part.mentionFirst) this.warn('image_mention_layout_unavailable');
            const upload = await uploadMedia(this.api, this.scope, this.target, part.media, () => this.#check());
            if (typeof upload.file_info !== 'string' || !upload.file_info) throw new AdapterError('API_RESPONSE');
            body = { msg_type: 7, content: part.text || ' ', media: { file_info: upload.file_info } };
          } else body = part.body ?? { msg_type: 0, content: part.text };
          sent.push(await post(body));
        }
        return { ...sent.at(-1), message_ids: sent.map(item => item.message_id), ...(this.warnings.size ? { warnings: [...this.warnings] } : {}) };
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
    const inherited = optionContext.getStore();
    const effective = extra ?? (inherited?.reply === reply ? inherited.extra : undefined);
    // The host wrapper drops the third argument and may schedule its own recall.
    // Carry options through async-local context and let the adapter handle them once.
    return optionContext.run({ reply, extra: effective }, () => fn(message, quote));
  };
  let current = guard((...args) => reply.send(...args));
  Object.defineProperty(event, 'reply', {
    enumerable: true, configurable: false,
    get: () => current,
    set: fn => { if (typeof fn === 'function') current = guard(fn); }
  });
}
