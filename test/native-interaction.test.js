import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

function interaction(scope = 'group', patch = {}) {
  return { op: 0, t: 'INTERACTION_CREATE', id: 'INTERACTION_CREATE:interaction-1', d: { id: 'interaction-1', application_id: '123456', type: 11, chat_type: scope === 'group' ? 1 : 2, scene: scope, timestamp: new Date().toISOString(), ...(scope === 'group' ? { group_openid: 'group-openid', group_member_openid: 'member-a' } : { user_openid: 'user-a' }), data: { type: 11, resolved: { button_id: 'confirm', button_data: 'opaque:data' } }, ...patch } };
}
test('button callback ACK is sent once, event reply uses event_id, and opaque payload never executes as a message', async () => {
  for (const scope of ['group', 'c2c']) {
    const f = fixture(), notices = [], messages = [];
    f.bot.on('notice', e => notices.push(e)); f.bot.on('message', e => messages.push(e));
    const event = await f.mapper.dispatch(interaction(scope));
    assert.equal(notices.length, 1); assert.equal(messages.length, 0); assert.equal(event.qqbot.buttonData, 'opaque:data');
    assert.equal(f.api.calls[0].method, 'PUT'); assert.equal(f.api.calls[0].route, '/interactions/interaction-1'); assert.equal(f.api.calls[0].body.code, 0);
    await f.mapper.dispatch(interaction(scope)); assert.equal(f.api.calls.length, 1);
    assert.ok((await event.reply('操作已收到')).message_id);
    assert.equal(f.api.calls[1].body.event_id, 'INTERACTION_CREATE:interaction-1'); assert.equal(f.api.calls[1].body.msg_id, undefined);
    assert.equal(event.isMaster, false); event.isMaster = true; assert.equal(event.isMaster, false);
  }
});
test('interaction rejects wrong app, invalid scopes, stale data and non-button types', async () => {
  const f = fixture();
  await assert.rejects(f.mapper.dispatch(interaction('group', { application_id: 'different-app' })), { code: 'EVENT_INVALID' });
  assert.equal(await f.mapper.dispatch(interaction('guild', { chat_type: 0 })), false);
  assert.equal(await f.mapper.dispatch(interaction('group', { timestamp: new Date(Date.now() - 400000).toISOString() })), false);
  assert.equal(await f.mapper.dispatch(interaction('group', { type: 18 })), false);
  assert.equal(f.api.calls.length, 0);
});
test('blocked interaction is acknowledged as denied without emitting a business event', async () => {
  const f = fixture({ allowedGroupOpenids: ['other-group'] }); let notices = 0;
  f.bot.on('notice', () => notices++);
  assert.equal(await f.mapper.dispatch(interaction()), false);
  assert.equal(f.api.calls.length, 1); assert.equal(f.api.calls[0].body.code, 4); assert.equal(notices, 0);
  await f.mapper.dispatch(interaction()); assert.equal(f.api.calls.length, 1);
});
