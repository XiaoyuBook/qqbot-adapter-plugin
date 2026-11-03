import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import lodash from 'lodash';
import moment from 'moment';
import { segment } from 'icqq';
import { harness, source } from './harness.js';
import { payload, png } from '../helpers.js';

async function businessModule(file, dependencies) {
  const context = vm.createContext({ segment, Buffer, console });
  const module = new vm.SourceTextModule(await source('miao', file), { context });
  await module.link(specifier => {
    const values = dependencies[specifier];
    if (!values) throw new Error(`Unexpected query import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

async function execute(f, App, scope, command) {
  const rendered = [], replies = [];
  App.prototype.renderImg = async (_plugin, template, data) => {
    rendered.push({ template, data });
    return { type: 'image', file: png };
  };
  const reply = App.prototype.reply;
  App.prototype.reply = function (...args) {
    const result = reply.apply(this, args); replies.push(result); return result;
  };
  await f.loader.loadPlugin({ name: 'real-query' }, App);
  const event = await f.mapper.dispatch(payload(scope, { content: command }));
  await f.flush(); await Promise.all(replies);
  return { event, rendered, messages: f.api.calls.filter(call => call.route.endsWith('/messages')) };
}

for (const scope of ['group', 'c2c']) test(`real ${scope} exploration uses the game avatar fallback and sends one result image`, async t => {
  const f = await harness(t, { adapterConfig: { mentionBeforeImage: true } });
  const stats = { active_day_number: 100, precious_chest_number: 1, luxurious_chest_number: 1, exquisite_chest_number: 1, common_chest_number: 1, magic_chest_number: 1, avatar_number: 10, role_combat: { is_unlock: false }, hard_challenge: { is_unlock: false } };
  const responses = [{ retcode: 0, data: { stats, role: { game_head_icon: 'https://example.test/game-avatar.png', nickname: '游戏昵称' }, world_explorations: [{ id: 1, name: '蒙德', exploration_percentage: 1000, level: 8 }] } }, { retcode: 0, data: {} }];
  class Base { constructor(e) { this.e = e; this.screenData = { pluResPath: '/test/' }; } }
  const gsCfg = { getRole: () => false, getdefSet: () => ({ common_chest: 100 }) };
  const model = await businessModule('plugins/genshin/model/roleIndex.js', {
    './base.js': { default: Base }, './mys/mysInfo.js': { default: { get: async () => structuredClone(responses) } },
    './gsCfg.js': { default: gsCfg }, lodash: { default: lodash }, moment: { default: moment },
    'node:fs': { default: {} }, '#miao.models': { Character: {} }
  });
  const app = await businessModule('plugins/genshin/apps/role.js', {
    '../../../lib/plugins/plugin.js': { default: f.Plugin }, 'node:fs': { default: { existsSync: () => true } },
    '../model/gsCfg.js': { default: gsCfg }, '../model/roleIndex.js': { default: model.default },
    '../model/abyss.js': { default: {} }, '../model/weapon.js': { default: {} }
  });
  const result = await execute(f, app.role, scope, '#探索度');
  assert.equal(result.rendered.length, 1, 'optional QQ avatar lookup must not abort the renderer');
  assert.equal(result.rendered[0].data.avatar, 'https://example.test/game-avatar.png');
  assert.equal(result.messages.length, 1, 'a completed query needs only its result image');
  assert.equal(result.messages[0].body.msg_type, scope === 'group' ? 2 : 7); assert.equal(result.event.qqbot.lastError, null);
  if (scope === 'group') assert.match(result.messages[0].body.markdown.content, /^<qqbot-at-user[^\n]+\n!\[图片\]/);
  assert.equal(f.logger.records.some(line => /UNSUPPORTED_API/.test(line)), false);
});

for (const scope of ['group', 'c2c']) test(`real ${scope} ledger statistics omit legacy result navigation and its empty extra bubble`, async t => {
  const f = await harness(t, { adapterConfig: { mentionBeforeImage: true } });
  class Ledger { async ledgerCount() { return { game: 'gs', total: 38997 }; } }
  const app = await businessModule('plugins/genshin/apps/ledger.js', {
    '../../../lib/plugins/plugin.js': { default: f.Plugin }, '../model/ledger.js': { default: Ledger },
    '../../../lib/puppeteer/puppeteer.js': { default: {} }, 'node:fs': { default: { existsSync: () => true } }
  });
  const result = await execute(f, app.ledger, scope, '#原石统计');
  assert.equal(result.rendered.length, 1); assert.match(result.rendered[0].template, /ledger-count/);
  assert.equal(result.messages.length, 1, 'do not append the records/statistics navigation to a completed chart');
  assert.equal(result.messages[0].body.msg_type, scope === 'group' ? 2 : 7); assert.equal(result.messages[0].body.keyboard, undefined);
  if (scope === 'group') assert.match(result.messages[0].body.markdown.content, /^<qqbot-at-user[^\n]+\n!\[图片\]/);
  assert.equal(result.event.qqbot.lastError, null);
});
