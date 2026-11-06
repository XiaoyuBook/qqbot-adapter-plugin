import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatSettings, parseSettingsCommand, settingsPanel, helpPanel, panelText, canManageSettings } from '../src/chat-settings.js';
import { replyPanel, createCommandPlugin } from '../src/commands.js';
import { AdapterController } from '../src/controller.js';
import { ConfigStore, defaults } from '../src/config.js';
import { host, fakeApi, quietLogger, config } from './helpers.js';

const master = 'LOCAL_MASTER';
const event = (patch = {}) => ({ isMaster: true, adapter: 'QQBot', qqbot: { appId: '123456', scope: 'group', userOpenid: master }, ...patch });
const cfg = patch => config({ masterGroupOpenids: [master], ...patch });

test('settings parser accepts documented forms, aliases and per-item defaults', () => {
  assert.deepEqual(parseSettingsCommand('#QQBot设置'), { type: 'view' });
  for (const suffix of ['帮助', '列表']) assert.deepEqual(parseSettingsCommand('#QQBot设置' + suffix), { type: 'view' });
  assert.equal(parseSettingsCommand(' #qqbot设置 免艾特 开启 ').patch.receiveGroupMessages, true);
  assert.equal(parseSettingsCommand('#QQ机器人设置图片@关闭').patch.mentionBeforeImage, false);
  assert.equal(parseSettingsCommand('#QQBot设置请求超时30').patch.requestTimeoutMs, 30000);
  assert.equal(parseSettingsCommand('#QQBot设置媒体上限50').patch.maxMediaBytes, 50 * 1024 * 1024);
  for (const item of chatSettings) assert.equal(parseSettingsCommand('#QQBot设置' + item.name + '默认').patch[item.key], defaults[item.key]);
  assert.equal(parseSettingsCommand('#其他设置'), null);
});
test('all setting examples, shorthand, explicit units and queries match the same definitions', () => {
  for (const item of chatSettings) {
    for (const name of [item.name, ...(item.aliases || [])]) {
      assert.deepEqual(parseSettingsCommand('#QQBot设置' + name), { type: 'query', item });
      assert.equal(parseSettingsCommand('#QQBot设置' + name + '恢复默认').patch[item.key], defaults[item.key]);
      if (item.factor) {
        for (const number of [item.min, item.max]) {
          assert.equal(parseSettingsCommand('#QQBot设置 ' + name + ' ' + number + ' ' + item.unit.toLowerCase()).patch[item.key], number * item.factor);
        }
      } else {
        for (const value of ['开启', '开', '启用', '关闭', '关', '禁用']) {
          assert.equal(parseSettingsCommand('#QQBot设置' + name + value).patch[item.key], ['开启', '开', '启用'].includes(value));
        }
        for (const value of ['1', '0', 'true']) assert.equal(parseSettingsCommand('#QQBot设置' + name + value).type, 'invalid');
      }
    }
  }
  const panel = settingsPanel(defaults);
  assert.deepEqual(panel.groups.map(group => group.rows.length), [5, 3, 3]);
  for (const row of panel.rows) {
    const parsed = parseSettingsCommand(row.example);
    assert.equal(parsed.type, 'set');
    assert.equal(parsed.item.name, row.name);
    assert.equal(parsed.patch[parsed.item.key], parsed.item.factor ? defaults[parsed.item.key] : true);
    assert.ok(panelText({ ...panel, version: 'test' }).includes(row.example));
  }
});
test('invalid input cannot write arbitrary keys, accept prototype values, or leak submitted text', () => {
  for (const suffix of ['免艾特constructor', '图片艾特toString', '群回复窗口0', '群回复窗口301', '私聊回复窗口3601', '回复次数6', '请求超时1.5', '请求超时1e2', '图片上限201', '媒体上限-1', '请求超时30次', '回复次数3秒', '图片上限8MB', '图片上限8MiB多余', '群回复窗口999999999999999999999秒', 'appSecret SECRET_SENTINEL', '__proto__ 开启']) {
    const result = parseSettingsCommand('#QQBot设置' + suffix);
    assert.equal(result.type, 'invalid', suffix);
    assert.equal(result.message.includes('SECRET_SENTINEL'), false);
  }
});
test('current local OpenID grants are required for QQBot settings; QQ group role and mapped QQ are insufficient', () => {
  assert.equal(canManageSettings(event(), cfg()), true);
  assert.equal(canManageSettings(event({ isMaster: false, isOwner: true, isAdmin: true }), cfg()), false);
  assert.equal(canManageSettings(event(), cfg({ masterGroupOpenids: [] })), false);
  for (const q of [{ appId: 'other' }, { scope: 'other' }, { userOpenid: 'other' }, { scope: 'c2c' }]) assert.equal(canManageSettings(event({ qqbot: { ...event().qqbot, ...q } }), cfg()), false);
  assert.equal(canManageSettings(event({ qqbot: { appId: '123456', scope: 'c2c', userOpenid: master } }), cfg({ masterC2COpenids: [master] })), true);
  assert.equal(canManageSettings({ isMaster: true }, cfg()), true);
  assert.equal(canManageSettings({ isMaster: 1 }, cfg()), false);
});
test('panel data and text include only allowed settings, never account identity or credentials', () => {
  const secret = 'SENSITIVE_SENTINEL';
  const data = settingsPanel({ ...defaults, appId: secret, appSecret: secret, userIdMappings: { [secret]: secret }, masterGroupOpenids: [secret], allowedC2COpenids: [secret] }, { state: 'online', reason: secret, session: secret });
  assert.equal(data.rows.length, 11); assert.equal(data.connection, '已连接');
  assert.equal(JSON.stringify(data).includes(secret), false);
  assert.equal(panelText({ ...data, version: 'test' }).includes(secret), false);
  assert.equal(settingsPanel(defaults, { state: secret }).connection, '状态未知');
  assert.equal(settingsPanel(defaults, { state: 'constructor' }).connection, '状态未知');
  const single = settingsPanel(defaults, { state: 'disabled' }, chatSettings[0]);
  assert.equal(single.rows.length, 1); assert.equal(single.groups.length, 1);
  assert.equal(single.rows[0].name, '免艾特'); assert.equal(single.online, false);
  assert.ok(single.notices.some(text => text.includes('#QQBot设置免艾特默认')));
});
test('help image uses host renderer and the existing reply path exactly once', async () => {
  const replies = [], image = { type: 'image', file: 'base64://VALID_IMAGE' };
  const e = { runtime: { async render(plugin, template, data, options) {
    assert.equal(plugin, 'qqbot-adapter-plugin'); assert.equal(template, 'panel/index');
    assert.equal(data.mode, 'help'); assert.equal(data.imgType, 'png'); assert.equal(options.retType, 'base64');
    return image;
  } }, reply: async value => { replies.push(value); return { message_id: 'sent' }; } };
  await replyPanel(e, helpPanel()); assert.deepEqual(replies, [image]);
});
test('concurrent panels finish reading the shared host template before the next render writes it', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  const rendered = [], replied = [];
  const event = { runtime: { async render(plugin, path, data) {
    rendered.push(data.title);
    if (rendered.length === 1) { started(); await gate; throw Error('RENDER_FAILURE'); }
    return { type: 'image', title: data.title };
  } }, reply: async value => { replied.push(value); return true; } };
  const first = replyPanel(event, settingsPanel(defaults));
  await firstStarted;
  const second = replyPanel(event, settingsPanel(defaults, {}, chatSettings[0]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rendered, ['适配器设置']);
  release(); await Promise.all([first, second]);
  assert.deepEqual(rendered, ['适配器设置', '免艾特设置']);
  assert.ok(replied.some(value => typeof value === 'string' && value.includes('适配器设置')));
  assert.ok(replied.some(value => value.title === '免艾特设置'));
});
test('renderer absence or failure and rejected image send fall back to usable text', async () => {
  for (const render of [undefined, async () => { throw Error('PRIVATE_RENDER_ERROR'); }, async () => false, async () => ({ type: 'image' })]) {
    const sent = [];
    await replyPanel({ runtime: render && { render }, reply: async value => { sent.push(value); return typeof value === 'string'; } }, helpPanel());
    assert.equal(typeof sent.at(-1), 'string'); assert.ok(sent.at(-1).includes('#QQBot设置'));
    assert.equal(sent.at(-1).includes('PRIVATE_RENDER_ERROR'), false);
  }
});

async function controllerFixture(t, initial = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-chat-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const store = new ConfigStore(path.join(directory, 'private'));
  await store.save({ ...cfg(), appSecret: 'UNIT_TEST_SECRET', enabled: true, ...initial });
  const calls = [], apis = []; let failStart = false;
  const controller = new AdapterController({ store, host: host(), logger: quietLogger(), apiFactory: () => { const api = fakeApi(); apis.push(api); return api; }, transportFactory: options => ({ start() { calls.push('start'); if (failStart) throw Error('PRIVATE_CONNECTION_DETAIL'); options.onStatus({ state: 'online' }); }, stop() { calls.push('stop'); } }) });
  t.after(() => controller.stop());
  await controller.start(); calls.length = 0;
  return { controller, store, calls, apis, fail: () => { failStart = true; } };
}
test('settings are saved before confirmation and confirmation finishes before old API disposal', async t => {
  const f = await controllerFixture(t); const old = f.apis[0];
  const result = await f.controller.configure({ receiveGroupMessages: true }, { authorize: c => canManageSettings(event(), c), acknowledge: async (saved, changed) => {
    assert.equal(saved.receiveGroupMessages, true); assert.equal(changed, true);
    assert.equal((await f.store.read()).config.receiveGroupMessages, true);
    assert.equal(old.closed, undefined); f.calls.push('ack');
  } });
  assert.deepEqual(f.calls, ['ack', 'stop', 'start']); assert.equal(result.applied, true);
  assert.equal(old.closed, true); assert.equal(f.controller.active.mapper.config.receiveGroupMessages, true);
  assert.equal((await f.store.read()).appSecret, 'UNIT_TEST_SECRET');
});
test('unchanged settings do not restart; rejected confirmation still applies saved settings', async t => {
  const f = await controllerFixture(t);
  const unchanged = await f.controller.configure({ mentionBeforeImage: false }, { authorize: () => true });
  assert.equal(unchanged.changed, false); assert.deepEqual(f.calls, []);
  await f.controller.configure({ mentionBeforeImage: true }, { authorize: () => true, acknowledge: async () => { throw Error('PRIVATE_ACK'); } });
  assert.deepEqual(f.calls, ['stop', 'start']); assert.equal(f.controller.active.mapper.config.mentionBeforeImage, true);
  assert.equal(JSON.stringify(f.controller.logger.records).includes('PRIVATE_ACK'), false);
});
test('queued edits are serialized and recheck current grants before saving', async t => {
  const f = await controllerFixture(t); const order = []; let release, arrived;
  const started = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = f.controller.configure({ requestTimeoutMs: 30000 }, { authorize: () => true, acknowledge: async () => { order.push('first'); arrived(); await gate; } });
  const second = f.controller.configure({ requestTimeoutMs: 45000 }, { authorize: () => true, acknowledge: async () => { order.push('second'); } });
  await started; assert.deepEqual(order, ['first']);
  release(); await Promise.all([first, second]); assert.deepEqual(order, ['first', 'second']);
  assert.equal(f.controller.active.mapper.config.requestTimeoutMs, 45000);
  await f.store.save({ masterGroupOpenids: [] });
  await assert.rejects(f.controller.configure({ maxReplies: 1 }, { authorize: c => canManageSettings(event(), c) }), { code: 'PERMISSION_REQUIRED' });
  assert.equal((await f.store.read()).config.maxReplies, 5);
});
test('reload failure is recorded as failure, while saved config remains and error details stay private', async t => {
  const f = await controllerFixture(t); f.fail();
  const result = await f.controller.configure({ requestTimeoutMs: 30000 }, { authorize: () => true });
  assert.equal(result.applied, false); assert.equal(f.controller.status.state, 'error');
  assert.equal(f.controller.active, null); assert.equal((await f.store.read()).config.requestTimeoutMs, 30000);
  assert.equal(JSON.stringify(f.controller.logger.records).includes('PRIVATE_CONNECTION_DETAIL'), false);
});
test('direct command handler enforces owner checks before viewing or saving settings', async () => {
  let reads = 0, changes = 0; const replies = [];
  const Plugin = class { constructor(options) { Object.assign(this, options); } };
  const Commands = createCommandPlugin(Plugin, { getRuntime: () => ({ store: { read: async () => { reads++; return { config: cfg() }; } }, controller: { configure: async () => changes++ } }) });
  const commands = new Commands();
  await commands.settings(event({ isMaster: false, msg: '#QQBot设置免艾特开启', reply: async value => replies.push(value) }));
  assert.equal(reads, 1); assert.equal(changes, 0); assert.deepEqual(replies, []);
});
test('single-item queries return current values without a controller or writes', async () => {
  const sent = [];
  const Plugin = class { constructor(options) { Object.assign(this, options); } };
  const Commands = createCommandPlugin(Plugin, { getRuntime: () => ({ store: { read: async () => ({ config: cfg({ requestTimeoutMs: 30000 }) }) } }) });
  await new Commands().settings(event({ msg: '#QQBot设置请求超时', reply: async value => sent.push(value) }));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('请求超时：30 秒'));
  assert.ok(sent[0].includes('默认 15 秒'));
  assert.equal(sent[0].includes('群回复窗口'), false);
});
