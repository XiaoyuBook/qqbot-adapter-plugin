import { AdapterError } from './errors.js';

// A local compatibility envelope, never a native QQ forward/XML message.
const contents = new WeakMap();
const boundary = Symbol('forward-node-boundary');
export const isForwardBoundary = value => value === boundary;
const MAX_NODES = 100, MAX_ITEMS = 1000, MAX_TEXT = 64000, MAX_DEPTH = 8;

function invalid() { throw new AdapterError('FORWARD_INVALID'); }
function limit() { throw new AdapterError('FORWARD_LIMIT'); }

function titleOf(message) {
  const title = message.data?.meta?.detail?.news?.[0]?.text;
  if (title === undefined) return '内容汇总';
  if (typeof title !== 'string') invalid();
  if (title.length > 500) limit();
  return title || '内容汇总';
}

function buttonsAsText(element, visit) {
  const rows = element.data;
  if (!Array.isArray(rows) || rows.length > 100) invalid();
  const lines = [];
  let size = 0;
  for (const row of rows) {
    const buttons = Array.isArray(row) ? row : [row];
    if (buttons.length > 100) limit();
    for (const button of buttons) {
      visit();
      if (!button || typeof button !== 'object' || typeof button.text !== 'string') invalid();
      const action = button.input ?? button.callback ?? button.link;
      if (action !== undefined && typeof action !== 'string') invalid();
      const text = button.text.trim(), value = action?.trim();
      if (text.length > 1000 || (value?.length ?? 0) > 1000) limit();
      if (text || value) {
        const line = value && value !== text ? `${text ? `${text}：` : ''}${value}` : text || value;
        if ((size += line.length + 1) > MAX_TEXT) limit();
        lines.push(line);
      }
    }
  }
  return lines.length ? `\n${[...new Set(lines)].join('\n')}` : '';
}

export function isForwardMessage(message) {
  return message !== null && typeof message === 'object' && contents.has(message);
}

export function forwardContent(message) {
  const stored = contents.get(message);
  if (!stored) invalid();
  return { items: [`${titleOf(message)}\n`, ...stored.items], warnings: ['forward_rendered_as_messages', ...stored.warnings] };
}

export async function makeForwardMsg(input) {
  const nodes = Array.isArray(input) ? input : [input];
  if (!nodes.length) invalid();
  if (nodes.length > MAX_NODES) limit();
  const items = [], warnings = new Set(), active = new Set();
  let textSize = 0, itemCount = 0, visited = 0;
  const visit = () => { if (++visited > MAX_ITEMS) limit(); };
  function add(item) {
    if (++itemCount > MAX_ITEMS) limit();
    if (typeof item === 'string') {
      textSize += item.length;
      if (textSize > MAX_TEXT) limit();
      if (!item) return;
    }
    items.push(item);
  }
  function append(message, depth = 0) {
    if (depth > MAX_DEPTH) limit();
    visit();
    if (Array.isArray(message)) {
      if (active.has(message)) invalid();
      active.add(message);
      for (const item of message) append(item, depth + 1);
      active.delete(message);
    } else if (isForwardMessage(message)) {
      const nested = forwardContent(message);
      nested.warnings.forEach(code => warnings.add(code));
      append(nested.items, depth + 1);
    } else if (isForwardBoundary(message)) add(message);
    else if (typeof message === 'string') add(message);
    else if (message?.type === 'text' && typeof message.text === 'string') add(message.text);
    else if (Buffer.isBuffer(message) || message instanceof Uint8Array) add(message);
    else if (['image', 'record', 'audio', 'video', 'file'].includes(message?.type)) add({ type: message.type, file: message.file ?? message.url, name: message.name });
    else if (['markdown', 'keyboard', 'card', 'media'].includes(message?.type)) add({ ...message });
    else if (message?.type === 'at') add({ type: 'at', qq: message.qq, id: message.id });
    else if (message?.type === 'button') {
      // Validate the legacy shape and bound its payload, but retain the keyboard
      // for the native sender. It is no longer flattened into plain commands.
      buttonsAsText(message, visit);
      add(structuredClone(message)); warnings.add('buttons_rendered_as_keyboard');
    } else invalid();
  }
  for (const [index, node] of nodes.entries()) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'message')) invalid();
    if (index) add(boundary);
    if (nodes.length > 1) {
      const name = node.nickname;
      if (name !== undefined && typeof name !== 'string') invalid();
      if ((name?.length ?? 0) > 200) limit();
      add(`${index + 1}. ${name || '内容'}\n`);
    }
    append(node.message);
  }
  if (!items.some(item => typeof item === 'string' ? item.trim() : item?.type !== 'at')) invalid();
  const envelope = { type: 'qqbot-forward', data: { meta: { detail: { news: [] } } } };
  contents.set(envelope, { items, warnings: [...warnings] });
  return envelope;
}
