import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { payload, config } from '../helpers.js';
import { createCommandPlugin } from '../../src/commands.js';

test('real Miao command routing: help is public, settings require trusted QQBot owner and unrelated business commands pass through', async t => {
  const master = '12345678901234567890123456789012';
  const f = await harness(t, { adapterConfig: { masterGroupOpenids: [master] } });
  const edits = [];
  const state = { store: { read: async () => ({ config: config({ masterGroupOpenids: [master] }) }) }, controller: { status: { state: 'online' }, configure: async (patch, options) => {
    const c = config({ masterGroupOpenids: [master] }); assert.equal(options.authorize(c), true);
    edits.push(patch); await options.acknowledge({ ...c, ...patch }, true);
  } } };
  await f.loader.loadPlugin({ name: 'qqbot-adapter-plugin' }, createCommandPlugin(f.Plugin, { getRuntime: () => state }));
  let index = 0;
  async function send(content, user = master) {
    const before = f.api.calls.length;
    await f.mapper.dispatch(payload('group', { id: 'settings-' + index++, content, author: { member_openid: user } })); await f.flush();
    return f.api.calls.slice(before).filter(call => call.route.endsWith('/messages'));
  }
  assert.ok((await send('#QQBot帮助', 'ordinary-user'))[0].body.content.includes('QQBot 使用帮助'));
  assert.ok((await send('#QQBot设置', 'ordinary-user'))[0].body.content.includes('只有主人'));
  assert.ok((await send('#QQBot设置免艾特开启', 'ordinary-user'))[0].body.content.includes('只有主人')); assert.equal(edits.length, 0);
  assert.ok((await send('#QQBot设置免艾特', 'ordinary-user'))[0].body.content.includes('只有主人'));
  assert.ok((await send('#QQBot设置'))[0].body.content.includes('连接：已连接'));
  assert.ok((await send('#qqbot设置 免艾特 开启'))[0].body.content.includes('已保存'));
  assert.deepEqual(edits, [{ receiveGroupMessages: true }]);
  assert.ok((await send('#QQBot设置请求超时'))[0].body.content.includes('默认 15 秒'));
  assert.equal(edits.length, 1);
  assert.ok((await send('#QQBot设置请求超时30秒'))[0].body.content.includes('已保存'));
  assert.ok((await send('#QQ机器人设置免@关'))[0].body.content.includes('已保存'));
  assert.deepEqual(edits.slice(1), [{ requestTimeoutMs: 30000 }, { receiveGroupMessages: false }]);
  assert.ok((await send('#QQBot设置列表'))[0].body.content.includes('资源限制'));
  assert.ok((await send('#QQBot help', 'ordinary-user'))[0].body.content.includes('QQBot 使用帮助'));
  assert.deepEqual(await send('#角色记录'), []);
});
