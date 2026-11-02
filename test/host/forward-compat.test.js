import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import util from 'node:util';
import lodash from 'lodash';
import { segment } from 'icqq';
import { harness, source } from './harness.js';
import { payload } from '../helpers.js';

for (const scope of ['group', 'c2c']) test(`real ${scope} genshin binding and common forward helper send usage in the fifth reply`, async t => {
  const f = await harness(t), saved = [];
  const commonModule = await f.hostModule('lib/common/common.js'); await commonModule.evaluate();
  const user = { addMysUser: async () => saved.push('add'), save: async () => saved.push('save') };
  const mys = { setCkData() {}, reqMysUid: async () => ({ status: 0 }), initCache: async () => {}, getUidInfo: () => 'FAKE_ACCOUNT', hasGame: () => true };
  class Base { constructor(e) { this.e = e; this.userId = e.user_id; } }
  const context = vm.createContext({ segment, logger: f.logger, Buffer, console });
  const dependencies = {
    './base.js': { default: Base }, './gsCfg.js': { default: { getConfig: () => ({}) } }, lodash: { default: lodash }, 'node:fs': { default: {} },
    '../../../lib/common/common.js': { default: commonModule.namespace.default }, './mys/mysInfo.js': { default: {} },
    './mys/NoteUser.js': { default: { create: async () => user } }, './mys/MysUser.js': { default: { create: async () => mys } },
    'node:util': { promisify: util.promisify }, yaml: { default: {} }, '#miao': { Data: {} }, '#miao.models': { Player: {} }, './db/index.js': { UserGameDB: {}, sequelize: {} }
  };
  const module = new vm.SourceTextModule(await source('miao', 'plugins/genshin/model/user.js'), { context });
  await module.link(specifier => {
    const values = dependencies[specifier]; if (!values) throw new Error(`Unexpected binding import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
  });
  await module.evaluate();
  class Probe extends f.Plugin {
    constructor() { super({ name: 'binding-probe', event: 'message.*', rule: [{ reg: '^#测试$', fnc: 'run', log: false }] }); }
    async run(e) {
      for (let i = 0; i < 3; i++) await e.reply('earlier login step');
      e.ck = 'ltoken=FAKE_LTOKEN;ltuid=12345;cookie_token=FAKE_COOKIE;';
      await new module.namespace.default(e).bing();
      return true;
    }
  }
  await f.loader.loadPlugin({ name: 'binding-probe' }, Probe);
  const event = await f.mapper.dispatch(payload(scope)); await f.flush();
  assert.deepEqual(saved, ['add', 'save']);
  const messages = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 5); assert.deepEqual(messages.map(call => call.body.msg_seq), [1, 2, 3, 4, 5]);
  assert.match(messages[3].body.content, /绑定Cookie成功/);
  assert.match(messages[4].body.content, /^绑定成功：使用命令说明\n/);
  assert.match(messages[4].body.content, /【#uid】/); assert.match(messages[4].body.content, /【\*uid】/);
  assert.equal(messages[4].body.msg_type, 0); assert.equal(event.qqbot.lastError, null);
  assert.equal(event.qqbot.compatibility.includes('forward_rendered_as_messages'), true);
  assert.equal(f.logger.records.some(line => /UNSUPPORTED_|REPLY_LIMIT/.test(line)), false);
  assert.equal(messages.some(call => /FAKE_LTOKEN|FAKE_COOKIE/.test(call.body.content)), false);
});
