import { validOpenid } from './config.js';
import { AdapterError } from './errors.js';
import { mediaUrl } from './media.js';

const invalid = () => { throw new AdapterError('UNSUPPORTED_OPTIONS'); };
function text(value, maximum, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > maximum || value.includes('\0')) invalid();
  return value;
}
export function markdown(value) {
  if (typeof value === 'string') value = { content: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowed = ['content', 'custom_template_id', 'params', 'force_verify_image_resource'];
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  if (value.content !== undefined) {
    if (value.custom_template_id !== undefined || value.params !== undefined) invalid();
    const result = { content: text(value.content, 20000) };
    if (value.force_verify_image_resource !== undefined) { if (typeof value.force_verify_image_resource !== 'boolean') invalid(); result.force_verify_image_resource = value.force_verify_image_resource; }
    return result;
  }
  text(value.custom_template_id, 128);
  if (!Array.isArray(value.params) || value.params.length > 100) invalid();
  return { custom_template_id: value.custom_template_id, params: value.params.map(item => {
    if (!item || !Array.isArray(item.values) || item.values.length > 100) invalid();
    return { key: text(item.key, 100), values: item.values.map(value => text(value, 4000, true)) };
  }) };
}
function permission(value) {
  if (!value) return { type: 2 };
  if (!value || typeof value !== 'object' || ![0, 1, 2].includes(value.type)) invalid();
  const result = { type: value.type };
  if (Object.keys(value).some(key => !['type', 'specify_user_ids'].includes(key))) invalid();
  if (value.type === 0) { if (!Array.isArray(value.specify_user_ids) || !value.specify_user_ids.length || value.specify_user_ids.length > 100 || !value.specify_user_ids.every(validOpenid)) invalid(); result.specify_user_ids = [...value.specify_user_ids]; }
  return result;
}
function button(value, id, scope) {
  if (!value || typeof value !== 'object') invalid();
  if (!value.action) {
    if (Object.keys(value).some(key => !['id', 'text', 'style', 'link', 'callback', 'input', 'permission', 'enter'].includes(key))) invalid();
    // Legacy Yunzai callback strings are commands, not opaque interaction data.
    const actionType = value.link ? 0 : 2;
    value = { id: value.id ?? id, render_data: { label: value.text, style: value.style ?? 1 }, action: { type: actionType, data: value.link ?? value.callback ?? value.input ?? value.text, permission: value.permission ?? { type: 2 }, ...(value.enter !== undefined ? { enter: value.enter } : {}) } };
  }
  const result = { id: text(String(value.id ?? id), 128), render_data: {}, action: {} };
  const render = value.render_data, action = value.action;
  if (!render || !action || ![0, 1, 2].includes(action.type)) invalid();
  if (Object.keys(value).some(key => !['id', 'render_data', 'action', 'group_id'].includes(key)) || Object.keys(render).some(key => !['label', 'visited_label', 'style'].includes(key)) || Object.keys(action).some(key => !['type', 'data', 'permission', 'unsupport_tips', 'reply', 'enter', 'anchor', 'modal'].includes(key))) invalid();
  const label = text(render.label, 100);
  if (Array.from(label).length > 10) invalid();
  result.render_data = { label, style: render.style ?? 1 };
  if (![0, 1, 3, 4].includes(result.render_data.style)) invalid();
  if (render.visited_label !== undefined) result.render_data.visited_label = text(render.visited_label, 100, true);
  result.action = { type: action.type, data: text(action.data, 4096), permission: permission(action.permission), unsupport_tips: text(action.unsupport_tips ?? '请更新 QQ 后使用', 100) };
  if (action.type === 0) result.action.data = mediaUrl(action.data);
  for (const key of ['reply', 'enter']) if (action[key] !== undefined) { if (typeof action[key] !== 'boolean') invalid(); if (key === 'enter' && action[key] && scope !== 'c2c') invalid(); result.action[key] = action[key]; }
  if (action.anchor !== undefined) { if (scope !== 'c2c' || action.anchor !== 1) invalid(); result.action.anchor = 1; }
  if (action.modal) result.action.modal = { content: text(action.modal.content, 40), confirm_text: text(action.modal.confirm_text ?? '确认', 4), cancel_text: text(action.modal.cancel_text ?? '取消', 4) };
  if (value.group_id !== undefined) result.group_id = text(value.group_id, 128);
  return result;
}
export function keyboard(value, scope) {
  if (Array.isArray(value)) {
    if (value.length > 100 || value.some(row => Array.isArray(row) && row.length > 100)) invalid();
    let rows = value.map(row => ({ buttons: Array.isArray(row) ? row : [row] }));
    if (rows.length > 5 || rows.some(row => row.buttons.length > 5)) {
      const all = rows.flatMap(row => row.buttons);
      if (all.length > 25) invalid();
      rows = [];
      for (let index = 0; index < all.length; index += 5) rows.push({ buttons: all.slice(index, index + 5) });
    }
    value = { content: { rows } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (value.id !== undefined) { if (value.content !== undefined) invalid(); return { id: text(value.id, 128) }; }
  const rows = value.content?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 5) invalid();
  const ids = new Set();
  return { content: { rows: rows.map((row, rowIndex) => {
    if (!row || !Array.isArray(row.buttons) || !row.buttons.length || row.buttons.length > 5) invalid();
    return { buttons: row.buttons.map((value, column) => { const item = button(value, `${rowIndex}-${column}`, scope); if (ids.has(item.id)) invalid(); ids.add(item.id); return item; }) };
  }) } };
}
export function card(value) {
  if (!value || value.type !== 'tuwen' || !value.content) invalid();
  return { type: 'tuwen', content: { title: text(value.content.title, 50), description: text(value.content.description, 200), url: mediaUrl(text(value.content.url, 1024)), pic_url: mediaUrl(text(value.content.pic_url, 1024)) } };
}
export const richSegment = Object.freeze({
  markdown: data => ({ type: 'markdown', data }),
  button: (...data) => ({ type: 'button', data }),
  keyboard: data => ({ type: 'keyboard', data }),
  card: data => ({ type: 'card', data })
});

export function keyboardText(value) {
  const lines = [];
  for (const row of value.content?.rows ?? []) for (const button of row.buttons) {
    const label = button.render_data.label, action = button.action;
    // Callback payloads can be opaque or private. Never display them as commands.
    lines.push(action.type === 1 ? `${label}（按钮暂不可用）` : action.data === label ? label : `${label}：${action.data}`);
  }
  return lines.length ? lines.join('\n') : '按钮暂不可用';
}
