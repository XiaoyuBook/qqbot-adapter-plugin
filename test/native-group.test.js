import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload } from './helpers.js';
import { AdapterError } from '../src/errors.js';

const memberId = 'qqbot:123456:group-user:member-b';
test('group/member queries use native endpoints and expose real platform names and roles', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload('group', { author: { member_openid: 'member-a', username: '平台昵称', member_role: 'admin' } }));
  assert.equal(e.sender.nickname, '平台昵称'); assert.equal(e.member.is_admin, true); assert.equal(e.isMaster, false);
  f.api.request = async (method, route) => {
    assert.equal(method, 'GET');
    if (route.endsWith('/info')) return { group_openid: 'group-openid', group_name: '平台群名', group_member_num: 2 };
    if (route.endsWith('/members/member-b')) return { member_openid: 'member-b', username: '成员乙', member_role: 'owner' };
    throw new Error('Unexpected read');
  };
  const info = await e.group.getInfo(); assert.equal(info.group_name, '平台群名');
  const member = await e.group.pickMember(memberId).renew(); assert.equal(member.nickname, '成员乙'); assert.equal(member.is_owner, true);
  assert.equal(f.registry.account.gml.get(e.group_id).get(memberId).role, 'owner');
});

test('member pagination follows opaque cursors, keeps namespaced IDs and rejects loops or malformed responses', async () => {
  const f = fixture({}, { sleep: async () => {} }), e = await f.mapper.dispatch(payload()), calls = [];
  f.api.request = async (_method, route) => {
    calls.push(route);
    return calls.length === 1 ? { members: [{ member_openid: 'a', username: '甲', member_role: 'member' }], next_cursor: 'opaque/next?=' } : { members: [{ member_openid: 'b', username: '乙', member_role: 'admin' }], next_cursor: '' };
  };
  const members = await e.group.getMemberMap();
  assert.equal(members.size, 2); assert.equal(members.get('qqbot:123456:group-user:b').is_admin, true);
  assert.match(calls[1], /cursor=opaque%2Fnext%3F%3D$/);
  f.api.request = async () => ({ members: [], next_cursor: 'same' });
  await assert.rejects(e.group.getMemberMap(), { code: 'API_RESPONSE' });
});

test('mute/unmute and member removal use documented operations with local ID and limit validation', async () => {
  let now = Date.now(); const f = fixture({}, { now: () => now }), e = await f.mapper.dispatch(payload()), calls = [];
  f.api.request = async (method, route, body) => { calls.push({ method, route, body }); return route.endsWith('batch_remove_members') ? { remove_members_result: 'success', add_to_member_blacklist_fail_openids: [] } : {}; };
  assert.equal(await e.group.muteMember(memberId, 60), true);
  assert.deepEqual(calls[0].body.members, [{ op: 'add', member_openid: 'member-b', mute_expire_at: new Date(now + 60000).toISOString() }]);
  assert.equal(await e.group.pickMember(memberId).mute(0), true); assert.equal(calls[1].body.members[0].op, 'del');
  assert.equal(await e.group.kickMember(memberId, true), true);
  assert.deepEqual(calls[2].body, { member_openids: ['member-b'], add_to_member_blacklist: true });
  await assert.rejects(e.group.muteMember('12345678', 60), { code: 'OPERATION_INVALID' });
  await assert.rejects(e.group.muteMember(memberId, 30 * 86400 + 1), { code: 'OPERATION_INVALID' });
  await assert.rejects(e.group.removeMembers(Array(21).fill(memberId)), { code: 'OPERATION_INVALID' });
  assert.equal(calls.length, 3);
});

test('approval, blacklist and permission/partial failure are explicit rather than fake success', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload()), calls = [];
  f.api.request = async (method, route, body) => { calls.push({ method, route, body }); return route.endsWith('member_blacklist') ? { fail_openids: [] } : {}; };
  assert.equal(await e.group.approveJoinRequest(memberId, 'request-id', false, '测试拒绝原因', true), true);
  assert.deepEqual(calls[0].body, { op: 'decline', join_request_id: 'request-id', reject_reason: '测试拒绝原因', add_to_member_blacklist: true });
  assert.equal(await e.group.setBlacklist([memberId], false), true); assert.equal(calls[1].body.op, 'del');
  f.api.request = async () => ({ fail_openids: ['member-b'] });
  await assert.rejects(e.group.setBlacklist([memberId]), { code: 'PARTIAL_FAILURE' });
  f.api.request = async () => { throw new AdapterError('PERMISSION_REQUIRED', { status: 403, platformCode: 11253 }); };
  await assert.rejects(e.group.getBotState(), { code: 'PERMISSION_REQUIRED' });
  await assert.rejects(e.group.kickMember(memberId), { code: 'PERMISSION_REQUIRED' });
});

test('full group messages and group membership/request events require their explicit receive switches', async () => {
  const disabled = fixture();
  assert.equal(await disabled.mapper.dispatch({ ...payload(), t: 'GROUP_MESSAGE_CREATE' }), false);
  const f = fixture({ receiveGroupMessages: true, receiveGroupNotices: true }), notices = [], requests = [];
  f.bot.on('notice', e => notices.push(e)); f.bot.on('request', e => requests.push(e));
  const ordinary = await f.mapper.dispatch({ ...payload(), t: 'GROUP_MESSAGE_CREATE' });
  assert.equal(ordinary.atBot, false); assert.equal(ordinary.message.some(part => part.type === 'at'), false);
  const join = { t: 'GROUP_JOIN_REQUEST', id: 'join-event', d: { group_openid: 'group-openid', member_openid: 'member-b', join_request_id: 'join-request', apply_at: new Date().toISOString(), verify_info: { verify_message: '申请消息' } } };
  await f.mapper.dispatch(join); await f.mapper.dispatch(join);
  assert.equal(requests.length, 1); assert.equal(requests[0].comment, '申请消息');
  const calls = []; f.api.request = async (...args) => { calls.push(args); return {}; };
  assert.equal(await requests[0].approve(true), true); assert.equal(calls[0][2].join_request_id, 'join-request');
  await f.mapper.dispatch({ t: 'GROUP_MEMBER_ADD', id: 'member-event', d: { group_openid: 'group-openid', member_openid: 'member-b', timestamp: Math.floor(Date.now() / 1000) } });
  assert.equal(notices.length, 1); assert.equal(notices[0].notice_type, 'increase');
  assert.equal(notices[0].user_id, memberId);
});
