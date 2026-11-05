import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import lodash from 'lodash';
import moment from 'moment';
import { segment } from 'icqq';
import { harness, source } from './harness.js';
import { payload, png } from '../helpers.js';
import { patchQrLogSource } from '../../scripts/prepare-qr-log-patch.mjs';

async function qrModules({ event, timers, logs, Model, renders = [] }) {
  const redisData = new Map();
  const context = vm.createContext({ Buffer, console, segment, process: { cwd: () => '/isolated' }, Bot: { logger: { mark: value => logs.push(value) } }, redis: { get: async key => redisData.get(key) ?? null, set: async (key, value) => redisData.set(key, value), del: async key => redisData.delete(key) }, setTimeout: callback => { timers.push(callback); return timers.length; } });
  const cache = new Map();
  const synthetic = (key, values) => {
    if (!cache.has(key)) cache.set(key, new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context }));
    return cache.get(key);
  };
  async function load(file, transform = value => value) {
    if (cache.has(file)) return cache.get(file);
    const module = new vm.SourceTextModule(transform(await source('xiaoyao', file)), { context, identifier: file }); cache.set(file, module);
    await module.link(async specifier => {
      if (specifier === 'lodash') return synthetic('lodash', { default: lodash });
      if (specifier === 'moment') return synthetic('moment', { default: moment });
      if (specifier.endsWith('/Changelog.js')) return synthetic('version', { isV3: true, currentVersion: 'test', yunzaiVersion: '3.1.3' });
      if (specifier.endsWith('/index.js')) return synthetic('cfg', { Cfg: { get: () => 0, scale: () => '' } });
      if (specifier.endsWith('/Common.js')) return load('components/Common.js');
      if (specifier.endsWith('/mys/utils.js')) return load('model/mys/utils.js');
      if (specifier === '../components/Data.js') return synthetic('data', { default: { createDir() {} } });
      if (specifier.endsWith('/lib/puppeteer/puppeteer.js')) {
        if (cache.has('miao-renderer')) return cache.get('miao-renderer');
        const wrapper = new vm.SourceTextModule(await source('miao', 'lib/puppeteer/puppeteer.js'), { context });
        cache.set('miao-renderer', wrapper);
        await wrapper.link(specifier => {
          assert.equal(specifier, '../renderer/loader.js');
          return synthetic('renderer-backend', { default: { getRenderer: () => ({ render: async (name, data) => { renders.push({ name, data }); return png; } }) } });
        });
        await wrapper.evaluate(); return wrapper;
      }
      if (specifier.endsWith('/mhyTopUpLogin.js')) return synthetic('model', { default: Model });
      if (specifier === './user.js') return synthetic('user', { bindStoken: async () => { throw new Error('No real account binding allowed in tests'); }, default: Model });
      throw new Error(`Unexpected QR fixture import: ${specifier}`);
    });
    await module.evaluate(); return module;
  }
  return { context, load, event };
}

for (const scope of ['c2c', 'group']) test(`actual ${scope} QR handler, renderer wrappers and delayed recall retain QR through real Miao`, async t => {
  const f = await harness(t); const timers = [], logs = [], renders = [];
  class FakeMys {
    constructor(e) { this.e = e; }
    async qrCodeLogin() { await this.e.reply('Test login notice', true); return { data: { url: 'https://example.test/FAKE_QR', ticket: 'FAKE_TICKET' } }; }
    async GetQrCode() { return false; }
  }
  const modules = await qrModules({ timers, logs, renders, Model: FakeMys });
  const app = await modules.load('apps/mhyTopUpLogin.js');
  const renderer = await modules.load('adapter/render.js');
  let runs = 0;
  class QRProbe extends f.Plugin {
    constructor() { super({ name: 'isolated-qr', event: 'message.*', rule: [{ reg: app.namespace.rule.qrCodeLogin.reg, fnc: 'run', log: false }] }); }
    async run(e) { runs++; return app.namespace.qrCodeLogin(e, { render: renderer.namespace.render }); }
  }
  await f.loader.loadPlugin({ name: 'isolated-qr' }, QRProbe);
  const event = await f.mapper.dispatch(payload(scope, { content: '#扫码绑定' })); await f.flush();
  assert.equal(runs, 1); assert.equal(timers.length, 1);
  const messages = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 2); assert.equal(messages[0].body.msg_type, 0); assert.equal(messages[1].body.msg_type, scope === 'group' ? 2 : 7);
  if (scope === 'group') {
    assert.match(messages[1].body.markdown.content, /^<qqbot-at-user[^\n]+\n/);
    assert.ok(messages[1].body.markdown.content.includes('请扫码'));
    assert.equal(event.qqbot.compatibility.includes('group_self_mention_omitted'), false);
  } else { assert.ok(messages[1].body.content.includes('请扫码')); assert.ok(event.qqbot.compatibility.includes('private_self_mention_omitted')); }
  assert.equal(event.qqbot.compatibility.includes('quote_display_unavailable'), true);
  assert.equal(event.qqbot.lastError, null);
  assert.equal(renders.length, 1); assert.equal(renders[0].name, 'xiaoyao-cvs-plugin/qrCode/index');
  assert.equal(renders[0].data.imgType, 'png'); assert.equal(renders[0].data.url, 'https://example.test/FAKE_QR');
  assert.doesNotThrow(() => timers[0]());
  await event.reply('after timer'); assert.equal(event.qqbot.lastError, null);
  assert.equal(f.api.calls.some(call => call.method === 'DELETE'), true);
});

test('two-line QR log sanitization preserves token result without logging credentials', async () => {
  const logs = [], timers = []; let count = 0;
  const fakeSecret = 'FAKE_QR_TOKEN_NEVER_PRINT';
  class User {
    async getData(action) {
      if (action === 'qrCodeQuery') return { data: ++count === 1 ? { status: 'Scanned', debug: fakeSecret } : { status: 'Confirmed', user_info: { aid: 'test-aid', mid: 'test-mid' }, tokens: [{ name: 'stoken_v2', token: fakeSecret }] } };
      if (action === 'bbsGetCookie') return { data: { cookie_token: 'FAKE_COOKIE' } };
      throw new Error('Unexpected request');
    }
  }
  const modules = await qrModules({ timers, logs, Model: User });
  const mod = await modules.load('model/mhyTopUpLogin.js', input => patchQrLogSource('model/mhyTopUpLogin.js', Buffer.from(input)).toString('utf8'));
  const session = new mod.namespace.default({ user_id: 'test-user', reply: async () => {} });
  const pending = session.GetQrCode('FAKE_TICKET');
  for (let i = 0; i < 30; i++) { while (timers.length) timers.shift()(); await Promise.resolve(); }
  const result = await pending;
  assert.equal(result.stoken.includes(fakeSecret), true); assert.equal(logs.length, 2);
  assert.equal(logs.join('\n').includes(fakeSecret), false); assert.equal(logs.join('\n').includes('FAKE_COOKIE'), false);
});

test('actual request layer never logs credentials in network errors or rejected requests', async () => {
  const logs = [], fakeSecret = 'FAKE_REQUEST_CREDENTIAL_NEVER_PRINT';
  let rejectNetwork = true;
  const log = { error: value => logs.push(value), debug: value => logs.push(value) };
  const context = vm.createContext({ Buffer, process: { cwd: () => '/isolated' }, logger: log, Bot: { logger: log } });
  const dependencies = {
    './utils.js': { default: { randomString: () => 'TEST_DEVICE' } },
    md5: { default: () => 'test-md5' }, lodash: { default: lodash }, fs: { default: {} }, yaml: { default: {} },
    '../../components/index.js': { Data: {} }, '../gsCfg.js': { default: {} }, '../../components/Changelog.js': { isV3: true },
    './mysTool.js': { default: {} }, crypto: { default: {} },
    'node-fetch': { default: async () => {
      if (rejectNetwork) throw new Error(`https://example.test/?stoken=${fakeSecret}`);
      return { ok: true, text: async () => JSON.stringify({ retcode: -1, data: fakeSecret }) };
    } }
  };
  const patched = patchQrLogSource('model/mys/mihoyoApi.js', Buffer.from(await source('xiaoyao', 'model/mys/mihoyoApi.js')));
  const module = new vm.SourceTextModule(patched.toString('utf8'), { context });
  await module.link(specifier => {
    const exports = dependencies[specifier];
    if (!exports) throw new Error(`Unexpected request fixture import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context });
  });
  await module.evaluate();
  const api = Object.create(module.namespace.default.prototype);
  Object.assign(api, { e: { uid: 'test-uid' }, getBody: () => ({}), getAgent: async () => null, getUrl: () => ({ url: `https://example.test/?stoken=${fakeSecret}`, headers: { Cookie: fakeSecret }, body: fakeSecret }) });
  assert.equal(await api.getData('qrCodeQuery'), false);
  rejectNetwork = false;
  const result = await api.getData('qrCodeQuery');
  assert.equal(result.retcode, -1); assert.equal(result.data, fakeSecret); assert.equal(result.api, 'qrCodeQuery');
  assert.equal(logs.length, 2); assert.equal(logs.join('\n').includes(fakeSecret), false);
  assert.throws(() => patchQrLogSource('model/mys/mihoyoApi.js', Buffer.from('unreviewed source')), /Unexpected Xiaoyao source/);
});
