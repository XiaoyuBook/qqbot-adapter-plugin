import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { createContractProbe } from './contract-probe.js';
import { payload, config, fakeApi, png } from '../helpers.js';
import { AdapterError } from '../../src/errors.js';
import { AdapterController } from '../../src/controller.js';

async function install(f, options = {}) {
  const results = [];
  const Probe = createContractProbe(f.Plugin, { Bot: f.bot, onResult: row => results.push(row), ...options });
  await f.loader.loadPlugin({ name: options.name ?? 'contract-probe' }, Probe);
  return results;
}
const messages = api => api.calls.filter(call => call.route.endsWith('/messages'));

test('public contract: one business-free probe consumes accounts, contacts, lists and receipts in group and C2C', async t => {
  const f = await harness(t); const rows = await install(f);
  for (const scope of ['group', 'c2c']) {
    await f.mapper.dispatch(payload(scope, { content: '#contract' })); await f.flush();
  }
  assert.equal(rows.length, 2);
  for (const { event, account, contact, userId, senderId, isMaster, result } of rows) {
    assert.equal(account, event.bot); assert.equal(account, f.bot[event.self_id]);
    assert.equal(userId, senderId); assert.equal(isMaster, false);
    assert.equal(contact.info[event.isGroup ? 'group_id' : 'user_id'], event.isGroup ? event.group_id : userId);
    for (const receipt of result) { assert.equal(receipt.ok, true); assert.equal(receipt.status, 'success'); assert.equal(receipt.message_ids.length, 1); }
    assert.equal(event.qqbot.lastReceipt, result[1]);
    for (const method of ['getMsg', 'getAvatarUrl', 'setGroupAdmin', 'setGroupCard', 'setGroupName', 'setGroupSpecialTitle']) assert.equal(account[method], undefined);
    for (const target of [contact, event.member].filter(Boolean)) {
      for (const method of ['getAvatarUrl', 'getChatHistory', 'getFileUrl', 'poke', 'setCard']) assert.equal(target[method], undefined);
    }
    if (event.isGroup) {
      assert.equal(event.member.group.group_id, event.group_id); assert.equal(event.member.info.group_id, event.group_id);
    } else assert.equal((await contact.getSimpleInfo()).user_id, userId);
  }
  const groups = await rows[0].account.getGroupList(), friends = await rows[1].account.getFriendList();
  assert.ok(groups instanceof Map); assert.equal(groups.get(rows[0].event.group_id).uin, rows[0].event.self_id);
  assert.equal(groups.get(rows[0].event.group_id).group_name, 'QQBot 群');
  assert.equal(friends.get(rows[1].userId).uin, rows[1].event.self_id);
  groups.clear(); friends.clear(); assert.equal(rows[0].account.gl.size, 1); assert.equal(rows[1].account.fl.size, 1);
  assert.deepEqual(messages(f.api).map(call => call.body.msg_seq), [1, 2, 1, 2]);
});

test('public contract: changing plugin name, command and text preserves element order and independent call boundaries', async t => {
  for (const [name, command, text] of [['first-caller', '#alpha', '先'], ['unrelated-caller', '#beta', 'second']]) {
    const f = await harness(t); const rows = await install(f, { name, pattern: `^${command}$`, exercise: async ({ event, contact }) => {
      const a = event.reply([{ type: 'image', file: png }, text]);
      const b = contact.sendMsg(`${text} next`);
      return Promise.all([a, b]);
    } });
    for (const scope of ['group', 'c2c']) { await f.mapper.dispatch(payload(scope, { content: command })); await f.flush(); }
    const sent = messages(f.api);
    assert.deepEqual(sent.map(call => call.body.msg_type), [7, 0, 0, 7, 0, 0]);
    assert.deepEqual(sent.map(call => call.body.msg_seq), [1, 2, 3, 1, 2, 3]);
    assert.deepEqual(sent.map(call => call.body.content), [' ', text, `${text} next`, ' ', text, `${text} next`]);
    assert.equal(rows.length, 2); assert.deepEqual(rows[0].result.map(r => r.completed_parts), [2, 1]);
  }
});

test('public contract: overlapping group and C2C events retain their own contacts, trigger IDs and queues', async t => {
  const f = await harness(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const rows = await install(f, { exercise: async ({ event, contact }) => {
    if (event.isGroup) await gate;
    const first = await contact.sendMsg(event.isGroup ? 'group' : 'c2c');
    release(); return [first, await event.reply('done')];
  } });
  await f.mapper.dispatch(payload('group', { content: '#contract', id: 'group-trigger' }));
  await f.mapper.dispatch(payload('c2c', { content: '#contract', id: 'c2c-trigger' })); await f.flush();
  assert.equal(rows.length, 2);
  for (const call of messages(f.api)) {
    assert.equal(call.body.msg_id, call.route.includes('/groups/') ? 'group-trigger' : 'c2c-trigger');
  }
  assert.deepEqual(messages(f.api).map(call => call.body.msg_seq).sort(), [1, 1, 2, 2]);
});

test('public contract: partial receipts survive the real host wrapper; unknown delivery is never resent', async t => {
  for (const scope of ['group', 'c2c']) for (const delivery of ['rejected', 'unknown']) {
    const f = await harness(t); const request = f.api.request.bind(f.api); let posts = 0;
    f.api.request = async (method, route, body) => {
      if (route.endsWith('/messages') && ++posts === 2) throw new AdapterError(delivery === 'unknown' ? 'API_NETWORK' : 'PERMISSION_REQUIRED', delivery === 'rejected' ? { status: 403, platformCode: 11253 } : {});
      return request(method, route, body);
    };
    const rows = await install(f, { exercise: ({ event }) => event.reply('a'.repeat(1501), false, { receipt: true }) });
    await f.mapper.dispatch(payload(scope, { content: '#contract' })); await f.flush();
    const receipt = rows[0].result;
    assert.equal(receipt.status, 'partial'); assert.equal(receipt.ok, false); assert.equal(receipt.completed_parts, 1);
    assert.deepEqual(receipt.message_ids, ['sent-1']); assert.equal(receipt.message_id, 'sent-1');
    assert.equal(receipt.failure.delivery, delivery); assert.equal(receipt.total_parts, 2); assert.equal(posts, 2);
    assert.equal(rows[0].event.qqbot.lastReceipt, receipt);
    assert.equal(await rows[0].eventContact.recallMsg(receipt.message_ids[0]), true);
  }
});

test('public contract: explicit proactive routing shares normalization but never inherits another scene passive quota', async t => {
  const f = await harness(t, { adapterConfig: { allowProactive: true } }); const rows = await install(f);
  for (const scope of ['group', 'c2c']) { await f.mapper.dispatch(payload(scope, { content: '#contract' })); await f.flush(); }
  const account = rows[0].account;
  await account.pickGroup(rows[0].event.group_id).sendMsg('scheduled', false, { receipt: true });
  await account.pickFriend(rows[1].event.user_id).sendMsg('scheduled', false, { receipt: true });
  for (const call of messages(f.api).slice(-2)) { assert.equal(call.body.content, 'scheduled'); assert.equal(call.body.msg_id, undefined); assert.equal(call.body.msg_seq, undefined); }
  assert.throws(() => account.pickFriend(rows[0].userId), { code: 'UNSUPPORTED_API' });
});

test('public contract: trusted identity reload/revocation, replay and two NapCat load orders use the same probe', async t => {
  const rawUser = '12345678901234567890123456789012';
  for (const order of ['before', 'after']) {
    const f = await harness(t, { userFactory: e => ({ dataOwner: e.user_id }) }); f.registry.dispose();
    let appId = '123456', mappings = { [`qqbot:123456:group-user:${rawUser}`]: '10001' };
    const controller = new AdapterController({ host: f.bot, logger: f.logger,
      store: { read: async () => ({ config: config({ appId, enabled: true, userIdMappings: mappings }), appSecret: 'FAKE_SECRET' }) },
      apiFactory: fakeApi, transportFactory: ({ onStatus }) => ({ start: () => onStatus({ state: 'online' }), stop: () => onStatus({ state: 'stopped' }) }) });
    t.after(() => controller.stop());
    const rows = await install(f, { exercise: async ({ event }) => ({ reply: await event.reply('identity'), dataOwner: event.runtime.user.dataOwner }) });
    if (order === 'before') await f.napcat();
    await controller.start(); if (order === 'after') await f.napcat();
    const nc = f.bot[10001];
    const incoming = (id, content) => payload('group', { id, content });
    await controller.active.mapper.dispatch(incoming('linked', '#contract')); await f.flush();
    assert.equal(rows.at(-1).userId, '10001'); assert.equal(rows.at(-1).isMaster, false);
    assert.equal(rows.at(-1).result.dataOwner, '10001');
    assert.equal(f.userIds.at(-1), '10001');
    await controller.active.mapper.dispatch(payload('c2c', { content: '#contract', id: 'private-unlinked' })); await f.flush();
    assert.equal(rows.at(-1).userId, 'qqbot:123456:c2c-user:c2c-openid'); assert.equal(rows.at(-1).isMaster, false);
    await controller.reload();
    await controller.active.mapper.dispatch(incoming('linked', '#contract')); await f.flush(); assert.equal(rows.length, 2);
    await controller.active.mapper.dispatch(incoming('reloaded', '#contract ')); await f.flush(); assert.equal(rows.at(-1).userId, '10001');
    const oldContact = rows.at(-1).eventContact;
    mappings = {}; await controller.reload();
    await controller.active.mapper.dispatch(incoming('revoked', '#contract  ')); await f.flush();
    assert.equal(rows.at(-1).userId, `qqbot:123456:group-user:${rawUser}`); assert.equal(f.userIds.at(-1), rows.at(-1).userId);
    assert.equal(await oldContact.sendMsg('offline'), false);
    const formerAccount = controller.active.registry.account;
    appId = '777777'; await controller.reload();
    await controller.active.mapper.dispatch(incoming('revoked', '#contract   ')); await f.flush();
    assert.equal(rows.at(-1).userId, `qqbot:777777:group-user:${rawUser}`);
    assert.equal(rows.at(-1).result.dataOwner, rows.at(-1).userId);
    assert.equal(f.bot['qqbot:123456'], undefined); assert.equal(formerAccount.isOnline(), false);
    assert.equal(f.bot[10001], nc); assert.equal(f.bot.uin, 10001);
    assert.equal(f.bot.adapter.filter(id => id === 'qqbot:777777').length, 1);
  }
});
