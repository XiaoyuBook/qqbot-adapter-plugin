import { AdapterError } from './errors.js';

const MAX_TEXT = 64000, MAX_ELEMENTS = 100, MAX_DEPTH = 8, MAX_ATTACHMENTS = 10;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function jumpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const text = value.trim();
  if (!text || /[\s\x00-\x1f\x7f]/.test(text)) return null;
  try {
    const url = new URL(text.startsWith('//') ? 'https:' + text : text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function attachmentPart(attachment) {
  const mime = typeof attachment?.content_type === 'string' ? attachment.content_type : '';
  const type = /^image\/(png|jpeg|gif|webp|bmp)$/.test(mime) ? 'image' : mime === 'voice' || /^audio\//.test(mime) ? 'record' : mime === 'video/mp4' ? 'video' : ['file', 'application/octet-stream'].includes(mime) ? 'file' : null;
  if (!type || typeof attachment.url !== 'string') return null;
  let url;
  try { url = new URL(attachment.url.startsWith('//') ? 'https:' + attachment.url : attachment.url); }
  catch { throw new AdapterError('EVENT_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AdapterError('EVENT_INVALID');
  return { type, url: url.href, file: url.href,
    ...(typeof attachment.filename === 'string' ? { name: attachment.filename.slice(0, 255) } : {}),
    ...(Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? { size: attachment.size } : {}),
    ...(type === 'record' && typeof attachment.asr_refer_text === 'string' ? { asr: attachment.asr_refer_text.slice(0, MAX_TEXT) } : {}) };
}

// Only current-message content becomes executable host text. Card labels, cover
// URLs, history and reference elements never supply commands or user identities.
export function incomingMessage(data, scope) {
  const items = [], unsupportedAttachments = [];
  const summary = { messageType: Number.isSafeInteger(data.message_type) ? data.message_type : null, cards: 0, mappedCards: 0, ignoredCards: 0, skippedHistory: 0, skippedAuthors: 0 };
  const userKey = scope === 'group' ? 'member_openid' : 'user_openid';
  let elements = 0, textLength = 0, attachments = 0;
  function text(value) {
    if (value === undefined) return;
    if (typeof value !== 'string' || (textLength += value.length) > MAX_TEXT) throw new AdapterError('EVENT_INVALID');
    if (value) items.push({ type: 'text', text: value });
  }
  function currentAuthor(author) {
    if (author === undefined) return true;
    if (!record(author) || author.bot === true) return false;
    if (author[userKey] !== undefined) return author[userKey] === data.author[userKey];
    if (author.id !== undefined) return typeof author.id === 'string' && author.id === data.author.id;
    // A cross-scope identity is not evidence that this is the current author.
    return author.member_openid === undefined && author.user_openid === undefined;
  }
  function visit(node, depth, root = false) {
    if (++elements > MAX_ELEMENTS || depth > MAX_DEPTH || !record(node)) throw new AdapterError('EVENT_INVALID');
    if (!root && !currentAuthor(node.author)) { summary.skippedAuthors++; return; }
    const type = node.message_type;
    if (type === 102 || type === 103 && !root) { summary.skippedHistory++; return; }
    if (type !== undefined && ![0, 3, 101, 103].includes(type)) return;
    const card = type === 3 || type === undefined && node.ark_data !== undefined;
    if (card) {
      summary.cards++;
      const url = record(node.ark_data) && record(node.ark_data.fields) ? jumpUrl(node.ark_data.fields.jump_url) : null;
      if (url) items.push({ type: 'card', url });
      else summary.ignoredCards++;
    } else {
      text(node.content);
      if (node.attachments !== undefined) {
        if (!Array.isArray(node.attachments) || (attachments += node.attachments.length) > MAX_ATTACHMENTS) throw new AdapterError('EVENT_INVALID');
        for (const attachment of node.attachments) {
          const part = attachmentPart(attachment);
          if (part) items.push(part);
          else unsupportedAttachments.push('unsupported');
        }
      }
    }
    // A root quote's content is the new reply. Its children describe old messages.
    if (type === 103) { if (node.msg_elements !== undefined) summary.skippedHistory++; return; }
    if (!card && [undefined, 101].includes(type) && node.msg_elements !== undefined) {
      if (!Array.isArray(node.msg_elements) || node.msg_elements.length > MAX_ELEMENTS) throw new AdapterError('EVENT_INVALID');
      for (const child of node.msg_elements) visit(child, depth + 1);
    }
  }
  visit(data, 0, true);
  const links = new Set();
  for (const item of items) if (item.type === 'text') {
    for (const match of item.text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      const url = jumpUrl(match[0].replace(/[.,;!，。；！、)\]}]+$/, ''));
      if (url) links.add(url);
    }
  }
  const parts = [];
  let outputLength = 0, textParts = 0;
  function appendText(value) {
    if ((outputLength += value.length + (textParts++ ? 1 : 0)) > MAX_TEXT) throw new AdapterError('EVENT_INVALID');
    const previous = parts.at(-1);
    if (previous?.type === 'text') previous.text += '\n' + value;
    else parts.push({ type: 'text', text: value });
  }
  for (const item of items) {
    if (item.type === 'card') {
      if (links.has(item.url)) continue;
      links.add(item.url); summary.mappedCards++; appendText(item.url);
    } else if (item.type === 'text') appendText(item.text);
    else parts.push(item);
  }
  return { parts, unsupportedAttachments, summary };
}
