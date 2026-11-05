import { AdapterError } from './errors.js';
import { cardDiagnostics } from './card-diagnostics.js';

const MAX_TEXT = 64000, MAX_ELEMENTS = 100, MAX_DEPTH = 8, MAX_ATTACHMENTS = 10;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Match the host/ICQQ JSON element contract. Preserve all provider card fields;
// interpreting a card's business links belongs to the consuming plugin.
function jsonCard(value) {
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw new AdapterError('EVENT_INVALID');
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!record(value)) return null;
  let nodes = 0;
  const ancestors = new Set();
  function validate(item, depth) {
    if (++nodes > 1024 || depth > MAX_DEPTH) throw new AdapterError('EVENT_INVALID');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.length > MAX_TEXT) throw new AdapterError('EVENT_INVALID'); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if ((!record(item) && !Array.isArray(item)) || ancestors.has(item)) throw new AdapterError('EVENT_INVALID');
    const keys = Object.keys(item);
    if (keys.length > 128) throw new AdapterError('EVENT_INVALID');
    ancestors.add(item);
    for (const key of keys) validate(item[key], depth + 1);
    ancestors.delete(item);
  }
  validate(value, 0);
  const data = JSON.stringify(value);
  if (data.length > MAX_TEXT) throw new AdapterError('EVENT_INVALID');
  return { type: 'json', data };
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

// Only current-message elements enter the host message. Cards retain JSON data;
// history, references and nested author metadata cannot supply new commands or identities.
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
      const part = jsonCard(node.ark_data ?? node.content);
      if (part) {
        items.push(part);
        summary.cardSchemas ??= [];
        if (summary.cardSchemas.length < 2) summary.cardSchemas.push(cardDiagnostics(JSON.parse(part.data), node.content));
      }
      else {
        summary.ignoredCards++;
        if (!summary.ignoredCardSchemas) summary.ignoredCardSchemas = [];
        if (summary.ignoredCardSchemas.length < 2) summary.ignoredCardSchemas.push(node.ark_data === null ? 'null' : Array.isArray(node.ark_data) ? 'array' : typeof node.ark_data);
      }
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
  const parts = [], cards = new Set();
  let outputLength = 0, values = 0;
  function reserve(length) {
    if ((outputLength += length + (values++ ? 1 : 0)) > MAX_TEXT) throw new AdapterError('EVENT_INVALID');
  }
  function appendText(value) {
    reserve(value.length);
    const previous = parts.at(-1);
    if (previous?.type === 'text') previous.text += '\n' + value;
    else parts.push({ type: 'text', text: value });
  }
  for (const item of items) {
    if (item.type === 'json') {
      if (cards.has(item.data)) continue;
      reserve(item.data.length); cards.add(item.data); summary.mappedCards++; parts.push(item);
    } else if (item.type === 'text') appendText(item.text);
    else parts.push(item);
  }
  return { parts, unsupportedAttachments, summary };
}
