import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Public installed Yenai 2.0.0 snapshots, GPL-3.0. Preserve the upstream files
// and license; only this checksum-guarded repair recipe is stored in the adapter.
export const yenaiGroupSources = {
  'model/GroupAdmin.js': 'c296d7350a7a3588e9076df8ffb59d93cf7e46a0c35bee839d509888509f8cf0',
  'apps/groupAdmin/groupAdmin.js': '5956dddbbc49d05ae5173d1daec311c10f576a6ec243b9af2ecb33857a42e666',
  'apps/groupAdmin/groupVerify.js': 'fff7cff75399904b3b84c6f51699e9b3e0a316b278e77a46ba6ea609fa314be4'
};

export function patchYenaiGroup(file, input) {
  if (createHash('sha256').update(input).digest('hex') !== yenaiGroupSources[file]) throw new Error('Unexpected installed Yenai source');
  const original = input.toString(), eol = original.includes('\r\n') ? '\r\n' : '\n';
  let source = original.replaceAll('\r\n', '\n');
  const replace = (from, to, count = 1) => {
    if (source.split(from).length !== count + 1) throw new Error('Yenai source marker changed');
    source = source.replaceAll(from, to);
  };
  if (file === 'model/GroupAdmin.js') {
    replace('this.Bot.pickGroup(groupId - 0).getMemberMap(true)', 'this.Bot.pickGroup(this.Bot.adapter === "QQBot" ? groupId : groupId - 0).getMemberMap(true)');
    replace('async getMuteList(groupId, info = false) {\n    let list = await this._getMemberMap(groupId)', 'async getMuteList(groupId, info = false) {\n    let list = this.Bot.adapter === "QQBot" ? await this.Bot.pickGroup(groupId).getMutedMembers() : await this._getMemberMap(groupId)');
    for (const method of ['async noactiveList(groupId, times = 1, unit = "月") {', 'async getNeverSpeak(groupId) {']) replace(method, method + '\n    if (this.Bot.adapter === "QQBot") throw new ReplyError("QQ 官方接口没有完整成员发言历史，不能据此判断或清理潜水/从未发言成员")');
    replace('if (!groupId || !(/^\\d+$/.test(groupId)))', 'if (this.Bot.adapter !== "QQBot" && (!groupId || !(/^\\d+$/.test(groupId))))');
    replace('if (!id || !(/^\\d+$/.test(id)))', 'if (this.Bot.adapter !== "QQBot" && (!id || !(/^\\d+$/.test(id))))');
  } else if (file === 'apps/groupAdmin/groupAdmin.js') {
    replace('async kickMember(e) {\n    if (!common.checkPermission(e, "admin", "admin")) return true\n    let qq = e.message.filter(item => item.type == "at").map(item => item.qq)', 'async kickMember(e) {\n    if (!common.checkPermission(e, "admin", "admin")) return true\n    let qq = getAtUserIds(e)');
  } else {
    const at = 'let qq = e.message.find(item => item.type == "at")?.qq';
    replace(at, 'let qq = e.message.find(item => item.type == "at" && item.qq !== "all" && String(item.qq) !== String(e.self_id) && String(item.qq) !== String(e.bot?.uin))?.qq', 2);
    replace('if (!(/\\d{5,}/.test(qq)))', 'if (e.bot?.adapter !== "QQBot" && !(/\\d{5,}/.test(qq)))');
    replace('  userId = Number(userId)\n  groupId = Number(groupId)', '  if (e.bot?.adapter !== "QQBot") { userId = Number(userId); groupId = Number(groupId) }');
  }
  return Buffer.from(source.replaceAll('\n', eol));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, outputRoot] = process.argv.slice(2);
  if (!sourceRoot || !outputRoot || path.resolve(sourceRoot) === path.resolve(outputRoot)) throw new Error('Usage: node scripts/prepare-yenai-group-patch.mjs <source-root> <separate-output-root>');
  for (const file of Object.keys(yenaiGroupSources)) {
    const output = path.join(outputRoot, file); await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, patchYenaiGroup(file, await fs.readFile(path.join(sourceRoot, file))), { flag: 'wx' });
  }
  console.log('Prepared checksum-verified Yenai group compatibility repairs.');
}
