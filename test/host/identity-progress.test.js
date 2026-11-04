import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { harness, source } from './harness.js';
import { payload, settle, fixture } from '../helpers.js';
import { patchGachaProgress } from '../../scripts/prepare-gacha-progress-patch.mjs';

test('real Miao runtime selects the existing legacy account without gaining master authority', async t => {
  const f = await harness(t, { adapterConfig: { userIdMappings: { 'qqbot:123456:group-user:12345678901234567890123456789012': '10001' } }, userFactory: e => e.user_id === '10001' ? { qq: '10001', getUid: () => '109000001', hasCk: true } : undefined });
  let observed;
  class Probe extends f.Plugin {
    constructor() { super({ name: 'identity-data', event: 'message.*', rule: [{ reg: '^#测试$', fnc: 'run', log: false }] }); }
    async run(e) { observed = { id: e.user_id, uid: e.runtime.user.uid, master: e.isMaster }; await e.reply('已读取旧账号'); return true; }
  }
  await f.loader.loadPlugin({ name: 'identity-data' }, Probe);
  await f.mapper.dispatch(payload()); await f.flush();
  assert.deepEqual(f.userIds, ['10001']); assert.deepEqual(observed, { id: '10001', uid: '109000001', master: false });
});

async function progressHandler({ adapter, patched = true, failure = false, command = '#更新抽卡记录', guarded = false }) {
  const sent = [], forwards = []; let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  class User { async cookie() {} async getData() { return { data: { authkey: 'FAKE_AUTHKEY' } }; } }
  class GachaLog {
    constructor(e) { this.e = e; }
    async logUrl() {
      await this.e.reply('链接发送成功，数据获取中……');
      await this.e.reply('开始获取角色记录，首次获取数据较多，请耐心等待...');
      reached(); await gate;
      if (failure) throw new Error('FAKE_NETWORK_FAILURE');
      await this.e.reply(['[角色]记录获取成功，更新60条\n', '抽卡记录更新完成']);
    }
  }
  const context = vm.createContext({ console, process: { cwd: () => '/fake' }, Bot: {}, redis: { get: async () => null, set() {} }, getServer: () => 'cn_gf01', configData: {} });
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
  const gacha = synthetic({ default: GachaLog }); await gacha.link(() => {}); await gacha.evaluate();
  const dependencies = {
    '../model/mys/utils.js': { default: { replyMake: async (e, list, skip) => { forwards.push(list.slice(skip)); await e._reply('FORWARD'); } } },
    '../components/index.js': { Cfg: {}, Data: {} }, moment: { default: {} }, '../components/Common.js': { default: {} },
    '../components/Changelog.js': { isV3: true }, '../model/gsCfg.js': { default: { getfileYaml: () => ({}) } }, fs: { default: {} }, yaml: { default: {} }, '../model/user.js': { default: User }
  };
  const original = Buffer.from(await source('xiaoyao', 'apps/user.js'));
  const module = new vm.SourceTextModule((patched ? patchGachaProgress(original) : original).toString(), { context, importModuleDynamically: async () => gacha });
  await module.link(specifier => { if (!dependencies[specifier]) throw new Error('Unexpected business import'); return synthetic(dependencies[specifier]); });
  await module.evaluate();
  let originalReply = async message => { sent.push(message); return { message_id: `test-${sent.length}` }; };
  const f = guarded ? fixture() : undefined;
  const event = guarded ? await f.mapper.dispatch(payload('c2c')) : { bot: { adapter }, user_id: '10001', isPrivate: true, reply: originalReply };
  if (guarded) {
    const base = event.reply;
    event.reply = (message, ...args) => { sent.push(message); return base(message, ...args); };
    originalReply = event.reply;
  }
  event.uid = '109000001'; event.msg = command;
  const work = module.namespace.gclog(event);
  if (/获取|导出/.test(command)) await work; else await started;
  await settle();
  return { event, sent, forwards, release, work, originalReply, f };
}

test('real Xiaoyao QQBot handler sends waiting progress before the delayed result and never builds a final replay', async () => {
  const f = await progressHandler({ adapter: 'QQBot' });
  assert.equal(f.sent.length, 2); assert.match(f.sent[1], /^开始获取/);
  f.release(); await f.work;
  assert.equal(f.sent.length, 3); assert.ok(Array.isArray(f.sent[2])); assert.equal(f.forwards.length, 0);
  assert.equal(f.event.reply, f.originalReply); assert.equal(f.event.msg, '#更新抽卡记录');
});

test('other adapters retain the legacy collector and QQBot restores replies after failure', async () => {
  const legacy = await progressHandler({ adapter: 'NapCat' }); assert.equal(legacy.sent.length, 1);
  legacy.release(); await legacy.work; assert.equal(legacy.forwards.length, 1); assert.equal(legacy.sent.at(-1), 'FORWARD');
  const failed = await progressHandler({ adapter: 'QQBot', failure: true }); failed.release();
  await assert.rejects(failed.work, /FAKE_NETWORK_FAILURE/);
  assert.equal(failed.event.reply, failed.originalReply); assert.equal(failed.event.msg, '#更新抽卡记录'); assert.equal(failed.forwards.length, 0);
});

test('original QQBot collector reproduces delayed progress while private link exports remain forward content', async () => {
  const original = await progressHandler({ adapter: 'QQBot', patched: false }); assert.equal(original.sent.length, 1);
  original.release(); await original.work; assert.equal(original.forwards.length, 1);
  const exported = await progressHandler({ adapter: 'QQBot', command: '#获取抽卡记录' });
  assert.equal(exported.forwards.length, 1); assert.equal(exported.event.reply, exported.originalReply);
  assert.equal(exported.event.msg, '#获取抽卡记录');
});

test('streamed progress works through the actual guarded reply setter within the C2C quota', async t => {
  const result = await progressHandler({ adapter: 'QQBot', guarded: true }); t.after(() => result.f.registry.dispose());
  assert.equal(result.f.api.calls.filter(call => call.route.endsWith('/messages')).length, 2);
  result.release(); await result.work;
  await result.event.reply('next reply');
  const messages = result.f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 4); assert.equal(messages[3].body.content, 'next reply');
  assert.equal(result.forwards.length, 0); assert.equal(result.event.qqbot.lastError, null);
});
