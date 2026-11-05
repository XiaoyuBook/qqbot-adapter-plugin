import { AdapterError } from './errors.js';
import { isForwardMessage, forwardContent, isForwardBoundary } from './forward.js';
import { prepareMedia, markdownImageDimensions } from './media.js';
import { markdown, keyboard, card } from './rich.js';

export const escapeMarkdown = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!~|])/g, '\\$1');

// Preserve element order and private forward-node boundaries while bounding
// recursive arrays before preparing any media or touching the network.
function elements(message, context) {
  const result = [], active = new Set();
  let visited = 0;
  function walk(value, depth = 0) {
    if (++visited > 2000 || depth > 16) throw new AdapterError('UNSUPPORTED_MESSAGE');
    if (Array.isArray(value)) {
      if (active.has(value)) throw new AdapterError('UNSUPPORTED_MESSAGE');
      active.add(value); for (const item of value) walk(item, depth + 1); active.delete(value);
    } else if (isForwardMessage(value)) {
      const forward = forwardContent(value); forward.warnings.forEach(context.warn);
      walk(forward.items, depth + 1);
    } else {
      result.push(value);
      if (result.length > 1000) throw new AdapterError('UNSUPPORTED_MESSAGE');
    }
  }
  walk(message); return result;
}

export async function messageParts(message, config, context) {
  let input = elements(message, context);
  const parts = [], mentions = new Set();
  const omitKeyboard = context.extra?.keyboard === false || context.extra?.button === false;
  const optionKeyboard = context.extra?.keyboard ?? context.extra?.button;
  if (context.extra?.at) input = [{ type: 'at', qq: context.extra.at === true ? context.senderId : context.extra.at }, ...input];
  let text = '', richText = '', rich = false, joinable = false;
  function flush() {
    if (!text && !richText) return;
    if (rich) parts.push({ body: { msg_type: 2, markdown: markdown(richText) }, caption: { text, mentions: [...mentions] } });
    else {
      const chars = Array.from(text);
      for (let index = 0; index < chars.length; index += 1500) parts.push({ text: chars.slice(index, index + 1500).join('') });
    }
    text = ''; richText = ''; rich = false; mentions.clear(); joinable = true;
  }
  function append(value) { text += value; richText += escapeMarkdown(value); }
  function attach(value) {
    const native = keyboard(value, context.scope), last = parts.at(-1);
    if (last?.text !== undefined && !last.media && joinable) {
      last.body = { msg_type: 2, markdown: markdown(escapeMarkdown(last.text.trim()) || '请选择操作'), keyboard: native }; delete last.text;
    } else if (last?.body?.msg_type === 2 && !last.body.keyboard && joinable) last.body.keyboard = native;
    else parts.push({ body: { msg_type: 2, markdown: markdown('请选择操作'), keyboard: native } });
    joinable = false;
  }
  for (const item of input) {
    if (isForwardBoundary(item)) { flush(); joinable = false; }
    else if (typeof item === 'string') append(item);
    else if (item?.type === 'text' && typeof item.text === 'string') append(item.text);
    else if (item?.type === 'at') {
      const id = item.id ?? item.qq;
      if (id === 'all' && context.scope !== 'group') throw new AdapterError('UNSUPPORTED_MESSAGE');
      const openid = id === 'all' ? null : context.registry?.openid(id, context.scope === 'group' ? 'group-user' : 'c2c-user');
      if (context.scope !== 'group') {
        if (openid !== context.target) throw new AdapterError('UNSUPPORTED_MESSAGE');
        context.warn('private_self_mention_omitted'); continue;
      }
      if (id !== 'all' && !openid) throw new AdapterError('UNSUPPORTED_MESSAGE');
      const tag = id === 'all' ? '<qqbot-at-everyone />' : '<qqbot-at-user id="' + openid + '" />';
      if (!mentions.has(tag)) { mentions.add(tag); richText += tag; rich = true; }
    } else if (Buffer.isBuffer(item) || item instanceof Uint8Array || ['image', 'record', 'audio', 'video', 'file'].includes(item?.type)) {
      flush();
      const kind = item?.type === 'audio' ? 'record' : item?.type ?? 'image';
      const media = await prepareMedia(kind, item?.type ? (item.file ?? item.url) : item, config, item?.name);
      const previous = joinable ? parts.at(-1) : undefined;
      const explicit = previous?.caption?.mentions ?? [];
      const wantsLayout = media.fileType === 1 && (explicit.length || context.imageMention);
      const dimensions = wantsLayout && context.registry?.imageReplies ? await markdownImageDimensions(media) : undefined;
      const part = { media };
      if (dimensions) {
        const tags = explicit.length ? explicit : ['<qqbot-at-user id="' + context.registry.openid(context.senderId, 'group-user') + '" />'];
        let caption = '';
        if (previous?.caption) { caption = previous.caption.text; parts.pop(); }
        else if (previous?.text !== undefined && !previous.media) { caption = previous.text; parts.pop(); }
        part.image = { dimensions, prefix: tags.join('\n'), caption: escapeMarkdown(caption.trim()) };
      } else {
        if (wantsLayout) context.warn('image_mention_layout_unavailable');
        if (previous?.text !== undefined && !previous.media) { part.text = previous.text; parts.pop(); }
      }
      parts.push(part); joinable = false;
    } else if (item?.type === 'media' && typeof item.file_info === 'string' && item.file_info && item.file_info.length <= 65536) {
      flush(); parts.push({ body: { msg_type: 7, media: { file_info: item.file_info }, content: ' ' } }); joinable = false;
    } else if (item?.type === 'markdown') {
      flush(); parts.push({ body: { msg_type: 2, markdown: markdown(item.data ?? item.content) } }); joinable = true;
    } else if (item?.type === 'button' || item?.type === 'keyboard') {
      if (omitKeyboard) { context.warn('keyboard_omitted_by_option'); if (!text.trim() && !rich) text = richText = ''; continue; }
      flush(); attach(item.data);
    } else if (item?.type === 'card') { flush(); parts.push({ body: { msg_type: 8, card: card(item.data ?? item.card) } }); joinable = false; }
    else if (item?.type === 'reply') {
      if (context.quote !== false && context.quote !== undefined) throw new AdapterError('UNSUPPORTED_OPTIONS');
      context.quote = { message_id: item.id };
    } else throw new AdapterError('UNSUPPORTED_MESSAGE');
  }
  if (omitKeyboard && !text.trim() && !rich) text = richText = '';
  flush();
  if (optionKeyboard !== undefined && !omitKeyboard) {
    if (parts.at(-1)?.body?.keyboard) throw new AdapterError('UNSUPPORTED_OPTIONS');
    attach(optionKeyboard);
  }
  if (!parts.length) throw new AdapterError('UNSUPPORTED_MESSAGE');
  return parts;
}
