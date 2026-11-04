import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload, png } from './helpers.js';
import { validateConfig } from '../src/config.js';

const member = '12345678901234567890123456789012';
const mappings = { [`qqbot:123456:group-user:${member}`]: '10001', 'qqbot:123456:c2c-user:c2c-openid': '10001' };

test('trusted aliases route group and private user data to legacy QQ while keeping transport scope and master authorization', async t => {
  const f = fixture({ userIdMappings: mappings }); t.after(() => f.registry.dispose());
  const group = await f.mapper.dispatch(payload());
  assert.equal(group.user_id, '10001'); assert.equal(group.sender.user_id, '10001'); assert.equal(group.member.user_id, '10001');
  assert.equal(group.qqbot.principalId, `qqbot:123456:group-user:${member}`);
  assert.equal(group.qqbot.userOpenid, member); assert.equal(group.isMaster, false);
  assert.equal(group.group.pickMember(`qqbot:123456:group-user:${member}`), group.member);
  group.isMaster = true; assert.equal(group.isMaster, false);
  assert.equal(f.registry.openid(10001, 'group-user'), member);
  assert.equal(f.registry.openid('qqbot:123456:group-user:' + member, 'group-user'), member);
  const sent = await group.reply([{ type: 'at', qq: 10001 }, 'legacy sender']); assert.ok(sent.message_id);
  assert.equal(f.api.calls.at(-1).route, '/v2/groups/group-openid/messages');
  const privateEvent = await f.mapper.dispatch(payload('c2c'));
  assert.equal(privateEvent.user_id, '10001'); assert.equal(privateEvent.qqbot.principalId, 'qqbot:123456:c2c-user:c2c-openid');
  assert.equal(f.registry.openid(10001, 'c2c-user'), 'c2c-openid');
  assert.equal(privateEvent.bot.pickFriend(10001).user_id, '10001');
});

test('mapped legacy sender mentions still encode the platform OpenID above the image', async t => {
  const f = fixture({ userIdMappings: mappings, mentionBeforeImage: true }); t.after(() => f.registry.dispose());
  const event = await f.mapper.dispatch(payload()); await event.reply(png);
  const message = f.api.calls.find(call => call.route.endsWith('/messages'));
  assert.match(message.body.markdown.content, new RegExp(`^<qqbot-at-user id="${member}" />`));
  assert.equal(message.body.markdown.content.includes('id="10001"'), false);
});

test('aliases remain AppID and scene scoped and never infer a legacy QQ from an incoming numeric claim', async t => {
  const f = fixture({ userIdMappings: { ...mappings, 'qqbot:999999:group-user:outsider': '10002' } }); t.after(() => f.registry.dispose());
  const stranger = await f.mapper.dispatch(payload('group', { id: 'stranger', author: { member_openid: '10001' }, content: '#绑定 10001' }));
  assert.equal(stranger.user_id, 'qqbot:123456:group-user:10001'); assert.equal(stranger.isMaster, false);
  assert.throws(() => f.registry.openid('10002', 'group-user'), { code: 'OPERATION_INVALID' });
  const other = fixture({ appId: '777777', userIdMappings: mappings }); t.after(() => other.registry.dispose());
  assert.equal((await other.mapper.dispatch(payload())).user_id, 'qqbot:777777:group-user:' + member);
});

test('mapping validation rejects unsafe identities, duplicates and malformed legacy targets', () => {
  for (const value of [null, [], { '__bad': '10001' }, { 'qqbot:123456:group:group': '10001' }, { 'qqbot:123456:group-user:user': '../escape' }, { 'qqbot:123456:group-user:user': 10001 }, { 'qqbot:123456:group-user:a': '10001', 'qqbot:123456:group-user:b': '10001' }]) {
    assert.throws(() => validateConfig({ userIdMappings: value }), { code: 'CONFIG_INVALID' });
  }
  assert.deepEqual(validateConfig({ userIdMappings: mappings }).userIdMappings, mappings);
});
