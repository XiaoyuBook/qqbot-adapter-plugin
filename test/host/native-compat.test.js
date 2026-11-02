import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.js';
import { payload, FakeTimers } from '../helpers.js';

test('real Miao notice loader handles native interaction once and returns event-based Markdown', async t => {
  const f = await harness(t); let runs = 0;
  class Probe extends f.Plugin {
    constructor() { super({ name: 'native-button', event: 'notice.qqbot.button', rule: [{ reg: '.*', fnc: 'run', log: false }] }); }
    async run(e) { runs++; assert.equal(e.qqbot.buttonData, 'opaque-data'); await e.reply(e.bot.segment.markdown('**回调已收到**')); return true; }
  }
  await f.loader.loadPlugin({ name: 'native-button' }, Probe);
  const event = { t: 'INTERACTION_CREATE', id: 'INTERACTION_CREATE:host-1', d: { id: 'host-1', type: 11, application_id: '123456', scene: 'group', chat_type: 1, group_openid: 'group-openid', group_member_openid: 'member-a', timestamp: new Date().toISOString(), data: { type: 11, resolved: { button_id: 'probe', button_data: 'opaque-data' } } } };
  await f.mapper.dispatch(event); await f.flush(); await f.mapper.dispatch(event); await f.flush();
  assert.equal(runs, 1); assert.equal(f.api.calls.filter(call => call.method === 'PUT').length, 1);
  const sent = f.api.calls.find(call => call.route.endsWith('/messages'));
  assert.ok(sent); assert.equal(sent.body.msg_type, 2); assert.equal(sent.body.event_id, event.id); assert.equal(sent.body.msg_id, undefined);
});

test('real host reply wrapper forwards native options once and does not arm duplicate recall timers', async t => {
  const f = await harness(t), timers = new FakeTimers(); f.registry.timers = timers;
  class Probe extends f.Plugin {
    constructor() { super({ name: 'native-options', event: 'message.*', rule: [{ reg: '^#测试$', fnc: 'run', log: false }] }); }
    async run(e) { await e.reply('测试正文', true, { recallMsg: 10, button: [[{ text: '查询', callback: '#uid' }]] }); return true; }
  }
  await f.loader.loadPlugin({ name: 'native-options' }, Probe);
  const event = await f.mapper.dispatch(payload('group', { message_scene: { ext: ['msg_idx=REFIDX_host==', 'auth_token=FAKE_NEVER_FORWARD'] } })); await f.flush();
  assert.equal(event.qqbot.lastError, null); assert.equal(f.registry.timerHandles.size, 1);
  assert.equal(f.api.calls[0].body.msg_type, 2); assert.equal(f.api.calls[0].body.keyboard.content.rows[0].buttons[0].action.data, '#uid');
  assert.equal(f.api.calls[0].body.message_reference.message_id, 'REFIDX_host==');
  await timers.tick(10000); assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(JSON.stringify(f.api.calls).includes('FAKE_NEVER_FORWARD'), false);
});
