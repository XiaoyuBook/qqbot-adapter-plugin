import { createHash } from 'node:crypto';

// Diagnostic output contains structure and counts only. Hash unknown field names
// and URL hosts; never include card text, link paths, credentials or identifiers.
const fields = new Set(['ark_name', 'ark_type', 'fields', 'prompt', 'preview', 'source', 'title', 'url', 'jump_url', 'jumpUrl', 'qqdocurl', 'meta', 'detail_1', 'news', 'desc', 'content', 'app', 'appid', 'view', 'ver', 'config', 'extra', 'link', 'target', 'data', 'json', 'web_url', 'webUrl', 'icon', 'tag']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const field = key => fields.has(key) ? key : '<field:' + hash(key) + '>';
const MAX_NODES = 32, MAX_DEPTH = 4;

function describe(value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const info = { type };
  if (type === 'string') {
    info.chars = value.length;
    info.encodedHttp = /https?%3a%2f%2f/i.test(value);
    const hosts = new Set();
    let urls = 0;
    for (const match of value.replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
      try {
        const url = new URL(match[0]);
        urls++;
        if (hosts.size < 4) hosts.add(hash(url.hostname.toLowerCase()));
      } catch { /* Malformed candidates reveal no values. */ }
    }
    info.httpUrls = urls;
    info.hosts = [...hosts];
  } else if (type === 'object') info.keys = Object.keys(value).length;
  else if (type === 'array') info.items = value.length;
  return info;
}

export function cardDiagnostics(data, content) {
  const nodes = [];
  let truncated = false;
  function visit(value, at, depth) {
    if (nodes.length >= MAX_NODES) { truncated = true; return; }
    nodes.push({ at, ...describe(value) });
    if (value === null || typeof value !== 'object') return;
    if (depth >= MAX_DEPTH) { if (Object.keys(value).length) truncated = true; return; }
    for (const key of Object.keys(value)) {
      if (nodes.length >= MAX_NODES) { truncated = true; break; }
      visit(value[key], at + '.' + (Array.isArray(value) ? '[]' : field(key)), depth + 1);
    }
  }
  visit(data, '$', 0);
  return { body: describe(content), nodes, truncated };
}
