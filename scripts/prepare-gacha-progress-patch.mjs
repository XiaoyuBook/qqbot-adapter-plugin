import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const gachaProgressSourceHash = '391aec44ef46f34c42d7085581b063a83061f0bfe0882cfd035ff859857b5ced';
export function patchGachaProgress(input) {
  if (createHash('sha256').update(input).digest('hex') !== gachaProgressSourceHash) throw new Error('Unexpected Xiaoyao gacha handler source');
  const text = input.toString('utf8'), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const start = text.indexOf('export async function gclog(e) {');
  const end = text.indexOf('async function getAuthKey(', start);
  if (start < 0 || end < 0) throw new Error('Gacha handler boundaries missing');
  let part = text.slice(start, end).replaceAll('\r\n', '\n');
  const replace = (before, after) => {
    if (part.split(before).length !== 2) throw new Error('Gacha handler pattern changed');
    part = part.replace(before, after);
  };
  replace('\te.msg = url', '\tconst originalMsg = e.msg;\n\te.msg = url');
  replace('\te._reply = e.reply;\n\te.reply = (msg) => {\n\t\tsendMsg.push(msg)\n\t}', [
    '\tconst isQQBot = e.bot?.adapter === "QQBot";',
    '\tconst streamReply = isQQBot && !isGet;',
    '\tconst reply = e.reply;',
    '\tif (streamReply) {',
    '\t\te.reply = (msg, ...args) => msg === "链接发送成功，数据获取中……" ? false : reply(msg, ...args);',
    '\t} else {',
    '\t\te._reply = e.reply;',
    '\t\te.reply = (msg) => { sendMsg.push(msg); };',
    '\t}',
    '\ttry {'
  ].join('\n'));
  replace('\tawait utils.replyMake(e, sendMsg, 1)', [
    '\tif (!streamReply) await utils.replyMake(e, sendMsg, 1)',
    '\t} finally {',
    '\t\tif (isQQBot) { e.reply = reply; e.msg = originalMsg; }',
    '\t}'
  ].join('\n'));
  return Buffer.from(text.slice(0, start) + part.replaceAll('\n', eol) + text.slice(end));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, target] = process.argv.slice(2);
  if (!source || !target || path.resolve(source) === path.resolve(target)) throw new Error('Usage: node scripts/prepare-gacha-progress-patch.mjs <original> <separate-output>');
  await fs.writeFile(target, patchGachaProgress(await fs.readFile(source)), { flag: 'wx' });
  console.log('Prepared checksum-verified QQBot progress compatibility patch.');
}
