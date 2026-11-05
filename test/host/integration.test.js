import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harness } from './harness.js';
import { payload, png } from '../helpers.js';

async function probe(f, options = {}) {
  const events = [];
  class Probe extends f.Plugin {
    constructor() { super({ name: 'isolated-probe', event: 'message.*', rule: [{ reg: '^#测试$', fnc: 'run', log: false, ...options }] }); }
    async run(e) { events.push(e); if (options.execute) await options.execute(e); return true; }
  }
  await f.loader.loadPlugin({ name: 'test-probe' }, Probe); return events;
}

test('real Miao loader + listener + Runtime + ICQQ bus process group and C2C once', async t => {
  const f = await harness(t); const events = await probe(f, { execute: e => e.reply(['ok', { type: 'image', file: png }]) });
  let childCalls = 0; f.bot.on('message.group', () => childCalls++);
  for (const scope of ['group', 'c2c']) {
    await f.mapper.dispatch(payload(scope)); await f.flush();
    await f.mapper.dispatch(payload(scope)); await f.flush();
  }
  assert.equal(events.length, 2); assert.equal(childCalls, 0); assert.equal(f.userIds.length, 2);
  for (const e of events) { assert.ok(e.runtime instanceof f.runtimeClass); assert.equal(e.bot, f.registry.account); assert.equal(e.msg, '#测试'); assert.equal(e.qqbot.lastError, null); }
  assert.equal(events[0].atBot, true); assert.equal(f.api.calls.length, 4);
  assert.equal(f.userIds[0], events[0].user_id); assert.equal(f.bot.uin, 88888);
});
test('real Miao permission filter accepts local OpenID grant, denies self-claim and masterQQ injection', async t => {
  const id = '12345678901234567890123456789012';
  const f = await harness(t, { adapterConfig: { masterGroupOpenids: [id] } }); const events = await probe(f, { permission: 'master' });
  await f.mapper.dispatch(payload()); await f.flush(); assert.equal(events.length, 1);
  f.cfg.masterQQ.push('qqbot:123456:c2c-user:c2c-openid');
  const denied = await f.mapper.dispatch(payload('c2c')); await f.flush(); assert.equal(events.length, 1); assert.equal(denied.isMaster, false);
  assert.match(f.api.calls[0].body.content, /只有主人/);
});

test('unmentioned group commands run once through the real Miao loader when group reception and host rules allow it', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true } });
  f.groupCfg.onlyReplyAt = 0;
  const events = await probe(f, { execute: e => e.reply('免 @ 指令已处理') });
  const message = { ...payload('group', { id: 'no-mention-command' }), t: 'GROUP_MESSAGE_CREATE' };
  const event = await f.mapper.dispatch(message); await f.flush();
  assert.equal(events.length, 1); assert.equal(events[0].msg, '#测试');
  assert.equal(event.atBot, false); assert.equal(event.message.some(item => item.type === 'at'), false);
  assert.equal(f.api.calls.length, 1); assert.equal(f.api.calls[0].body.msg_id, 'no-mention-command');
  await f.mapper.dispatch(message); await f.flush();
  // Two platform event names for the same underlying message also stay deduplicated.
  await f.mapper.dispatch({ ...message, t: 'GROUP_AT_MESSAGE_CREATE' }); await f.flush();
  await f.mapper.dispatch({ ...message, d: { ...message.d, id: 'ordinary-chat', content: '今天下午好' } }); await f.flush();
  assert.equal(events.length, 1); assert.equal(f.api.calls.length, 1);
});

test('unmentioned group reception never bypasses the host mention requirement or group allowlist', async t => {
  const f = await harness(t, { adapterConfig: { receiveGroupMessages: true, allowedGroupOpenids: ['group-openid'] } });
  const events = await probe(f);
  const message = { ...payload('group', { id: 'host-denied' }), t: 'GROUP_MESSAGE_CREATE' };
  await f.mapper.dispatch(message); await f.flush(); assert.equal(events.length, 0);
  f.groupCfg.onlyReplyAt = 0;
  assert.equal(await f.mapper.dispatch({ ...message, d: { ...message.d, id: 'allowlist-denied', group_openid: 'other-group' } }), false);
  await f.flush(); assert.equal(events.length, 0);
  // A distinct raw message avoids the host's 200 ms identical-text throttle.
  const event = await f.mapper.dispatch({ ...message, d: { ...message.d, id: 'now-allowed', content: '#测试 ' } });
  await f.flush(); assert.equal(events.length, 1); assert.equal(event.atBot, false); assert.equal(event.isMaster, false);
});
test('real Miao blacklist / whitelist and group-only-at filters work with namespaced IDs', async t => {
  const f = await harness(t); const events = await probe(f);
  f.other.blackGroup = ['qqbot:123456:group:group-openid']; await f.mapper.dispatch(payload()); await f.flush(); assert.equal(events.length, 0);
  f.other.blackGroup = []; f.other.whiteQQ = ['qqbot:123456:c2c-user:c2c-openid'];
  await f.mapper.dispatch(payload('c2c')); await f.flush(); assert.equal(events.length, 1);
  await f.mapper.dispatch(payload('group', { id: 'other' })); await f.flush(); assert.equal(events.length, 1);
});
test('real Miao wrapper keeps boolean quote compatibility and rejects button/at/recall options', async t => {
  const f = await harness(t); const results = [];
  await probe(f, { execute: async e => {
    results.push(await e.reply('no', false, { button: [] })); results.push(await e.reply('no', false, { at: { bad: true } })); results.push(await e.reply('no', false, { recallMsg: 121 })); results.push(await e.reply('no', true)); results.push(await e.reply('ok'));
  } });
  const e = await f.mapper.dispatch(payload()); await f.flush();
  assert.deepEqual(results.slice(0, 3), [false, false, false]); assert.ok(results[3].message_id); assert.ok(results[4].message_id); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_OPTIONS'); assert.equal(f.api.calls.length, 3);
});
test('real NapCat BotInit before/after QQBot retains default account and event routing through ICQQ', async t => {
  for (const order of ['before', 'after']) {
    const f = await harness(t); const events = await probe(f);
    if (order === 'before') { f.registry.dispose(); await f.napcat(); f.registry.register(); f.registry.setOnline(true); }
    const nc = await f.napcat(); const ncAccount = f.bot[10001];
    assert.equal(f.bot.uin, 10001); assert.equal(f.bot[f.registry.id], f.registry.account);
    const event = await f.mapper.dispatch(payload()); await f.flush(); assert.equal(events.length, 1); assert.equal(events[0].bot, f.registry.account);
    await nc.dealEvent({ self_id: 10001, post_type: 'message', message_type: 'private', user_id: 20001, message_id: 'nc-message', sender: { nickname: 'Fake user' }, message: [{ type: 'text', data: { text: '#测试' } }] }, ['message', 'message.private']); await f.flush();
    assert.equal(events.length, 2); assert.equal(events[1].bot, ncAccount); assert.equal(events[1].adapter, 'NapCat');
    f.registry.setOnline(false); await nc.BotInit(); f.registry.setOnline(true);
    assert.equal(f.bot.uin, 10001); assert.equal(event.bot, f.registry.account); assert.equal(f.bot.adapter.filter(v => v === f.registry.id).length, 1);
  }
});
test('real Miao loads lifecycle and command plugins only; repeated lifecycle init is harmless', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-bootstrap-')); t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const before = { Bot: globalThis.Bot, logger: globalThis.logger, plugin: globalThis.plugin, directory: process.env.QQBOT_ADAPTER_PRIVATE_DIR };
  process.env.QQBOT_ADAPTER_PRIVATE_DIR = temp;
  const f = await harness(t); globalThis.Bot = f.bot; globalThis.logger = f.logger; globalThis.plugin = f.Plugin;
  const key = Symbol.for('qqbot-adapter-plugin.runtime.v1');
  t.after(async () => { await globalThis[key]?.controller?.stop(); delete globalThis[key]; globalThis.Bot = before.Bot; globalThis.logger = before.logger; globalThis.plugin = before.plugin; if (before.directory === undefined) delete process.env.QQBOT_ADAPTER_PRIVATE_DIR; else process.env.QQBOT_ADAPTER_PRIVATE_DIR = before.directory; });
  const entry = await import('../../index.js'); assert.deepEqual(Object.keys(entry), ['apps']); assert.equal(Object.keys(entry.apps).length, 2);
  const { QQBotAdapterBootstrap: Bootstrap, QQBotCommands } = entry.apps; await f.loader.loadPlugin({ name: 'qqbot-adapter-plugin' }, Bootstrap); await f.loader.loadPlugin({ name: 'qqbot-adapter-plugin' }, Bootstrap);
  await f.loader.loadPlugin({ name: 'qqbot-adapter-plugin' }, QQBotCommands);
  assert.equal(f.loader.priority.length, 1); assert.equal(f.loader.priority[0].name, 'QQBot帮助与设置'); assert.equal(globalThis[key].controller.status.state, 'disabled'); assert.equal(globalThis[key].controller.active, null);
});
