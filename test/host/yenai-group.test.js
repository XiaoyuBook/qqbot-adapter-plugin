import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import lodash from 'lodash';
import moment from 'moment';
import { segment } from 'icqq';
import { eventContext } from '../../src/context.js';
import { harness } from './harness.js';
import { payload, settle } from '../helpers.js';
import { patchYenaiGroup } from '../../scripts/prepare-yenai-group-patch.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('./yenai-manifest.json', import.meta.url)));
async function yenai(file, patched = true) {
  const bytes = await fs.readFile(new URL(`../../.verification-cache/yenai-group/${file}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[file], 'public installed source checksum');
  return patched && file !== 'lib/common/common.js' ? patchYenaiGroup(file, bytes).toString() : bytes.toString();
}

async function business(t, { patched = true } = {}) {
  const f = await harness(t, { adapterConfig: { groupManagement: true, receiveGroupMessages: true } }); f.groupCfg.onlyReplyAt = 0;
  const timers = new Map(), calls = [], realRequest = f.api.request.bind(f.api); let timerId = 0;
  f.api.request = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.endsWith('/bot_state')) return { member_openid: 'own', member_role: 'admin' };
    if (route.endsWith('/batch_remove_members')) return { remove_members_result: 'success', add_to_member_blacklist_fail_openids: [] };
    if (route.endsWith('/restrict_chat_setting') && method === 'GET') return { global_rule: { mode: 'none' }, members: [{ member_openid: 'target', username: '测试对象', mute_expire_at: new Date(Date.now() + 60000).toISOString() }] };
    return realRequest(method, route, body);
  };
  const Config = { masterQQ: [], groupAdmin: { whiteQQ: [], groupVerify: { openGroup: [], times: 3, range: { min: 1, max: 100 }, time: 120, remindAtLastMinute: false } } };
  const Time_unit = { 秒: 1, 分: 60, 分钟: 60, 小时: 3600, 天: 86400 };
  const context = vm.createContext({ plugin: f.Plugin, Bot: f.bot, segment, logger: f.logger, console: { log() {} }, ReplyError: class ReplyError extends Error {}, redis: { get: async () => null, set() {} }, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  async function load(code, dependencies) {
    const module = new vm.SourceTextModule(code, { context });
    await module.link(specifier => {
      const values = dependencies[specifier]; if (!values) throw new Error(`Unexpected Yenai public import: ${specifier}`);
      return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
    }); await module.evaluate(); return module.namespace;
  }
  const common = (await load(await yenai('lib/common/common.js'), { lodash: { default: lodash }, moment: { default: moment }, '#yenai.components': { Config, Version: { name: 'Miao-Yunzai' }, Log_Prefix: '[test]' }, './sendMsgMod.js': { default: class {} } })).default;
  const Ga = (await load(await yenai('model/GroupAdmin.js', patched), { lodash: { default: lodash }, moment: { default: moment }, '../components/index.js': { Config }, './index.js': { QQApi: class {} }, '../constants/other.js': { Time_unit, ROLE_MAP: {} }, '../tools/formatDuration.js': { default: () => '1分钟' }, 'node-schedule': { default: { scheduleJob() { throw new Error('No real scheduled tasks'); } } }, '../lib/common/common.js': { default: common } })).default;
  const App = (await load(await yenai('apps/groupAdmin/groupAdmin.js', patched), { lodash: { default: lodash }, '../../components/index.js': { Config }, '../../constants/other.js': { Time_unit }, '../../model/index.js': { GroupAdmin: Ga, GroupBannedWords: class {}, common }, '../../tools/index.js': { cronValidate: () => true, translateChinaNum: value => Number(value) }, './groupWhiteListCtrl.js': { GroupWhiteListCtrl: class {} } })).GroupAdmin;
  return { ...f, calls, Config, Ga, App, load, common, timers, async verification() { return load(await yenai('apps/groupAdmin/groupVerify.js', patched) + '\nexport { verify }; export const verificationState = temp;', { '../../components/index.js': { Config, Log_Prefix: '[test]' }, '../../model/index.js': { common, GroupAdmin: Ga }, lodash: { default: lodash }, '../../tools/index.js': { sleep: async () => {} } }); } };
}

function command(content, id, role = 'admin') {
  return { ...payload('group', { id, content, author: { member_openid: 'actor', member_role: role }, mentions: [{ member_openid: 'target', username: '测试对象' }] }), t: 'GROUP_MESSAGE_CREATE' };
}

test('actual Yenai permission check and mute command work with the real host loader and platform @ targets', async t => {
  const f = await business(t); await f.loader.loadPlugin({ name: 'real-yenai-group' }, f.App);
  const e = await f.mapper.dispatch(command('#禁言5分钟 <@target>', 'mute-command')); await f.flush(); await settle();
  const mute = f.calls.find(call => call.method === 'POST' && call.route.endsWith('/restrict_chat_setting'));
  assert.ok(mute); assert.equal(mute.body.members[0].member_openid, 'target'); assert.equal(mute.body.members[0].op, 'add');
  assert.equal(e.isMaster, false); assert.equal(e.group.is_admin, true); assert.equal(e.member.is_admin, true);
  assert.equal(f.calls.filter(call => call.route.endsWith('/messages')).length, 1);
});

test('actual Yenai kick handler excludes the bot mention and preserves scoped group/member IDs', async t => {
  const f = await business(t); await f.loader.loadPlugin({ name: 'real-yenai-group' }, f.App);
  const p = command('#踢 <@target>', 'kick-command'); p.t = 'GROUP_AT_MESSAGE_CREATE';
  await f.mapper.dispatch(p); await f.flush(); await settle();
  const kicks = f.calls.filter(call => call.route.endsWith('/batch_remove_members'));
  assert.equal(kicks.length, 1); assert.deepEqual(kicks[0].body.member_openids, ['target']); assert.equal(kicks[0].body.add_to_member_blacklist, false);
});

test('actual Yenai permission filter still rejects ordinary members before a moderation API call', async t => {
  const f = await business(t); await f.loader.loadPlugin({ name: 'real-yenai-group' }, f.App);
  await f.mapper.dispatch(command('#禁言5分钟 <@target>', 'denied-command', 'member')); await f.flush(); await settle();
  assert.equal(f.calls.some(call => call.method === 'POST' && call.route.endsWith('/restrict_chat_setting')), false);
  assert.match(f.calls.find(call => call.route.endsWith('/messages')).body.content, /仅限管理/);
});

test('actual Yenai muted list uses official mute state and never guesses a member history for mass cleanup', async t => {
  const f = await business(t), e = await f.mapper.dispatch(command('#测试', 'model-command'));
  const model = new f.Ga(e), list = await model.getMuteList(e.group_id);
  assert.equal(list.length, 1); assert.equal(list[0].user_id, 'qqbot:123456:group-user:target'); assert.ok(list[0].shutup_time > Date.now() / 1000);
  assert.equal(f.calls.some(call => call.route.endsWith('/members')), false);
  await assert.rejects(model.getNeverSpeak(e.group_id), /没有完整成员发言历史/);
  await assert.rejects(model.noactiveList(e.group_id), /没有完整成员发言历史/);
});

test('actual Yenai verification keeps string identity keys and its simulated expiry targets the same member', async t => {
  const f = await business(t), module = await f.verification(), e = await f.mapper.dispatch(command('#测试', 'verification-command'));
  const userId = 'qqbot:123456:group-user:target', sent = [];
  await eventContext.run({ registry: f.registry, scope: 'group', target: 'group-openid' }, () => module.verify(userId, e.group_id, { ...e, reply: async message => { sent.push(message); return true; } }));
  assert.ok(module.verificationState[`${e.group_id}:${userId}`]); assert.equal(Object.keys(module.verificationState).some(key => key.includes('NaN')), false);
  assert.equal(sent[0][0].qq, userId);
  const timer = [...f.timers.values()].find(item => item.ms === 120000); await timer.fn(); await settle();
  const kick = f.calls.find(call => call.route.endsWith('/batch_remove_members')); assert.deepEqual(kick.body.member_openids, ['target']);
});

test('real Miao request and notice loaders coexist with direct ICQQ child listeners without duplicate execution', async t => {
  const f = await business(t); f.mapper.config.receiveGroupNotices = true;
  let notices = 0, requests = 0, directNotices = 0, directRequests = 0;
  class Notice extends f.Plugin {
    constructor() { super({ name: 'group-notice', event: 'notice.group.increase', rule: [{ reg: '.*', fnc: 'run', log: false }] }); }
    async run(e) { notices++; assert.equal(e.self_id, f.registry.id); assert.equal(e.group.is_admin, true); return true; }
  }
  class Request extends f.Plugin {
    constructor() { super({ name: 'group-request', event: 'request.group.add', rule: [{ reg: '.*', fnc: 'run', log: false }] }); }
    async run(e) { requests++; assert.equal(e.isMaster, false); await e.approve(false, '测试拒绝'); return true; }
  }
  await f.loader.loadPlugin({ name: 'group-notice' }, Notice); await f.loader.loadPlugin({ name: 'group-request' }, Request);
  f.bot.on('notice.group.increase', () => directNotices++); f.bot.on('request.group.add', () => directRequests++);
  const notice = { t: 'GROUP_MEMBER_ADD', id: 'real-host-join', d: { group_openid: 'group-openid', member_openid: 'target', timestamp: Math.floor(Date.now() / 1000) } };
  const request = { t: 'GROUP_JOIN_REQUEST', id: 'real-host-request', d: { group_openid: 'group-openid', member_openid: 'target', join_request_id: 'request-opaque', apply_at: new Date().toISOString(), verify_info: { verify_message: '申请' } } };
  await f.mapper.dispatch(notice); await f.flush(); await f.mapper.dispatch(request); await f.flush();
  await f.mapper.dispatch(notice); await f.mapper.dispatch(request); await f.flush();
  assert.equal(notices, 1); assert.equal(requests, 1); assert.equal(directNotices, 1); assert.equal(directRequests, 1);
  const approval = f.calls.filter(call => call.route.includes('/approval_join_request/')); assert.equal(approval.length, 1); assert.equal(approval[0].body.op, 'decline');
});

test('Yenai repair recipes refuse source drift and retain numeric operations and historical-data handling in other adapters', async t => {
  await assert.rejects(async () => patchYenaiGroup('model/GroupAdmin.js', Buffer.from('changed')), /Unexpected installed Yenai source/);
  const f = await business(t), observed = [], member = { user_id: 23456, role: 'member', join_time: 123, last_sent_time: 123 };
  const group = { getMemberMap: async () => new Map([[23456, member]]), pickMember: () => ({ info: member }), kickMember: async (id, block) => { observed.push({ id, block }); return true; } };
  const bot = { adapter: 'NapCat', uin: 77777, pickGroup: id => { observed.push(id); return group; } };
  const model = new f.Ga({ bot }); await model._getMemberMap('12345'); assert.equal(observed[0], 12345);
  const never = await model.getNeverSpeak('12345'); assert.equal(never[0].user_id, 23456);
  assert.match(await model.kickMember('12345', '23456', '99999'), /踢出群聊/);
  assert.deepEqual(observed.at(-1), { id: '23456', block: false });
  await assert.rejects(model.kickMember('12345', 'qqbot:123456:group-user:target', '99999'), /正确的QQ号/);
});
