import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload, settle } from './helpers.js';
import { eventContext } from '../src/context.js';
import { AdapterError } from '../src/errors.js';
import { apiRouteAllowed } from '../src/api.js';
import { segment } from 'icqq';

const user = 'qqbot:123456:group-user:target';
const join = (id = 'join-1', target = 'group-openid') => ({ t: 'GROUP_JOIN_REQUEST', id, d: { group_openid: target, member_openid: 'target', username: '申请人', join_request_id: id, apply_at: new Date().toISOString(), verify_info: { verify_message: '验证消息' } } });

test('real bot role is hydrated once, held member properties refresh, and a bot administrator is never a local master', async t => {
  const f = fixture({ groupManagement: true }); t.after(() => f.registry.dispose());
  let botRole = 'admin', memberRole = 'admin', reads = 0;
  f.api.request = async (_method, route) => route.endsWith('/bot_state') ? (reads++, { member_openid: 'own', member_role: botRole }) : { member_openid: 'target', username: '更新后', member_role: memberRole };
  const e = await f.mapper.dispatch(payload('group', { author: { member_openid: 'actor', member_role: 'owner' } }));
  assert.equal(e.group.is_admin, true); assert.equal(e.group.is_owner, false); assert.equal(e.isMaster, false); assert.equal(e.member.is_owner, true);
  const own = e.group.pickMember(e.self_id); assert.equal(own.is_admin, true);
  const member = e.group.pickMember(user); await member.renew(); assert.equal(member.role, 'admin'); assert.equal(member.is_admin, true); assert.equal(member.nickname, '更新后');
  memberRole = 'member'; await member.getInfo(); assert.equal(member.role, 'member'); assert.equal(member.is_admin, false);
  await f.mapper.dispatch(payload('group', { id: 'second' })); assert.equal(reads, 1);
  botRole = 'member'; await e.group.getBotState(); assert.equal(e.group.is_admin, false); assert.equal(own.is_admin, false);
});

test('failed group role queries keep privileges false and do not break ordinary message handling', async t => {
  const f = fixture({ groupManagement: true }); t.after(() => f.registry.dispose());
  f.api.request = async () => { throw new AdapterError('PERMISSION_REQUIRED', { platformCode: 11253 }); };
  const e = await f.mapper.dispatch(payload()); assert.ok(e); assert.equal(e.group.is_admin, false); assert.equal(e.group.is_owner, false); assert.equal(e.isMaster, false);
  assert.equal(f.logger.records.filter(line => line.includes('group_state')).length, 1);
  await f.mapper.dispatch(payload('group', { id: 'cached-failure' })); assert.equal(f.logger.records.filter(line => line.includes('group_state')).length, 1);
});

test('cached role refreshes do not delay ordinary commands and concurrent first reads share one request', async t => {
  let now = Date.now(), release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ groupManagement: true }, { now: () => now }); t.after(() => f.registry.dispose());
  f.api.request = async () => { reads++; await gate; return { member_openid: 'own', member_role: 'admin' }; };
  const one = f.registry.ensureGroupState('group-openid'), two = f.registry.ensureGroupState('group-openid');
  assert.equal(reads, 1); release(); await Promise.all([one, two]);
  now += 61000; let finish;
  const refresh = new Promise(resolve => { finish = resolve; });
  f.api.request = async () => { reads++; await refresh; return { member_openid: 'own', member_role: 'member' }; };
  const cached = await f.registry.ensureGroupState('group-openid'); assert.equal(cached.member_role, 'admin');
  assert.equal(reads, 2); finish(); await settle(); assert.equal(f.registry.groupStates.get('group-openid').value.member_role, 'member');
});

test('stopping during the initial role read never emits a late message or membership event', async () => {
  for (const notice of [false, true]) {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const f = fixture({ groupManagement: true, receiveGroupNotices: true }); let emitted = 0;
    f.bot.on(notice ? 'notice' : 'message', () => emitted++);
    f.api.request = async () => { await gate; return { member_openid: 'own', member_role: 'admin' }; };
    const pending = f.mapper.dispatch(notice ? { t: 'GROUP_MEMBER_ADD', id: 'stopping-join', d: { group_openid: 'group-openid', member_openid: 'target', timestamp: Math.floor(Date.now() / 1000) } } : payload());
    await settle(); f.registry.dispose(); release(); assert.equal(await pending, false); assert.equal(emitted, 0); assert.equal(f.registry.groupStates.size, 0);
  }
});

test('ICQQ group/member/account aliases retain blacklist flags for boolean and reason-slot kick signatures', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload()), calls = [];
  f.api.request = async (method, route, body) => { calls.push({ method, route, body }); return route.endsWith('/batch_remove_members') ? { remove_members_result: 'success', add_to_member_blacklist_fail_openids: [] } : {}; };
  await e.group.mute(user, 60); await e.bot.setGroupBan(e.group_id, user, 0);
  await e.group.kick(user, true); await e.group.kickMember(user, '', true); await e.group.pickMember(user).kick('', true); await e.bot.setGroupKick(e.group_id, user, true);
  assert.equal(calls.length, 6); assert.ok(calls.slice(2).every(call => call.body.add_to_member_blacklist === true && call.body.member_openids[0] === 'target'));
  await assert.rejects(e.group.kick(user, '无法传给平台的理由'), { code: 'UNSUPPORTED_API' });
  assert.throws(() => e.group.muteAll(true), { code: 'GROUP_WHOLE_MUTE_UNSUPPORTED' }); assert.equal(calls.length, 6);
});

test('standard root and direct request/notice listeners each receive one event with bound approval flags', async t => {
  const f = fixture({ receiveGroupNotices: true }); t.after(() => f.registry.dispose());
  const seen = { root: 0, direct: 0, requests: 0, joins: 0 }; let request;
  f.bot.on('notice', () => seen.root++); f.bot.on('notice.group.increase', () => seen.direct++);
  f.bot.on('request', e => { request = e; seen.requests++; }); f.bot.on('request.group.add', () => seen.joins++);
  const notice = { t: 'GROUP_MEMBER_ADD', id: 'member-join', d: { group_openid: 'group-openid', member_openid: 'target', timestamp: Math.floor(Date.now() / 1000) } };
  await f.mapper.dispatch(notice); await f.mapper.dispatch(notice); await f.mapper.dispatch(join()); await f.mapper.dispatch(join());
  assert.deepEqual(seen, { root: 1, direct: 1, requests: 1, joins: 1 }); assert.equal(request.request_type, 'group'); assert.equal(request.comment, '验证消息'); assert.match(request.flag, /^qqbot-request:/);
  const pending = await f.registry.account.getSystemMsg(); assert.equal(pending.length, 1); assert.equal(pending[0].flag, request.flag);
  f.api.calls.length = 0;
  await request.approve(true); await f.registry.account.setGroupAddRequest(request.flag, true);
  assert.equal(f.api.calls.length, 1); assert.equal(f.api.calls[0].body.join_request_id, 'join-1');
  await assert.rejects(request.approve(false), { code: 'OPERATION_INVALID' });
  await assert.rejects(f.registry.account.setGroupAddRequest('join-1', true), { code: 'MESSAGE_UNKNOWN' });
});

test('approval flags never escape the originating group or account and expire without guessing requests', async t => {
  const f = fixture({ receiveGroupNotices: true }); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(join());
  await assert.rejects(eventContext.run({ registry: f.registry, scope: 'group', target: 'other-group' }, () => e.approve()), { code: 'TARGET_DENIED' });
  const other = fixture(); t.after(() => other.registry.dispose()); await assert.rejects(other.registry.account.setGroupAddRequest(e.flag), { code: 'MESSAGE_UNKNOWN' });
  f.registry.now = () => Date.now() + 3600001; await assert.rejects(e.approve(), { code: 'MESSAGE_UNKNOWN' });
});

test('strategy execution is asynchronous acceptance and validates every associated group before POST', async t => {
  const f = fixture({ allowedGroupOpenids: ['group-openid'] }); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
  let groups = ['group-openid'], numericGroups = [], cursor = '', posts = 0;
  f.api.request = async (method, route) => {
    if (method === 'POST') { posts++; assert.equal(route, '/v2/groups/join_approval_strategy/st_1/execute'); return {}; }
    return { strategies: [{ strategy_id: 'st_1', is_enable: 'on', group_openids: groups, group_ids: numericGroups, expire_at: new Date(Date.now() + 86400000).toISOString() }], next_cursor: cursor };
  };
  assert.deepEqual(await e.group.executeJoinApprovalStrategy('st_1'), { accepted: true, strategy_id: 'st_1' }); assert.equal(posts, 1);
  groups = ['group-openid', 'other-group']; await assert.rejects(e.group.executeJoinApprovalStrategy('st_1'), { code: 'TARGET_DENIED' });
  groups = []; numericGroups = ['12****34']; await assert.rejects(e.group.executeJoinApprovalStrategy('st_1'), { code: 'TARGET_DENIED' }); assert.equal(posts, 1);
  assert.equal(apiRouteAllowed('GET', '/v2/groups/join_approval_strategy?limit=50'), true);
  assert.equal(apiRouteAllowed('POST', '/v2/groups/join_approval_strategy/st_1/execute'), true);
  assert.equal(apiRouteAllowed('POST', '/v2/groups/join_approval_strategy/st_1/delete'), false);
});

test('documented @ tags become separate target segments while unverified literal tags remain command text', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch({ ...payload('group', { content: '#禁言5分钟 <@target>', mentions: [{ member_openid: 'target', username: '对象' }] }), t: 'GROUP_MESSAGE_CREATE' });
  assert.equal(e.atBot, false); assert.equal(e.message.filter(item => item.type === 'at')[0].qq, user);
  assert.equal(e.message.filter(item => item.type === 'text').map(item => item.text).join('').trim(), '#禁言5分钟');
  const literal = await f.mapper.dispatch({ ...payload('group', { id: 'literal', content: '#禁言 <@unknown>' }), t: 'GROUP_MESSAGE_CREATE' });
  assert.equal(literal.message.some(item => item.type === 'at'), false); assert.equal(literal.message[0].text, '#禁言 <@unknown>');
  await settle();
});

test('the real ICQQ segment.at bridge preserves scoped IDs only inside this account context and restores the native method', async () => {
  const original = segment.at, f = fixture({}, { segment });
  try {
    const native = segment.at(user); assert.equal(native.qq, 0);
    const bridged = eventContext.run({ registry: f.registry }, () => segment.at(user)); assert.equal(bridged.qq, user);
    const other = eventContext.run({ registry: {} }, () => segment.at(user)); assert.equal(other.qq, 0);
    assert.equal(f.registry.account.segment.at('all').qq, 'all');
  } finally { f.registry.dispose(); }
  assert.equal(segment.at, original);
});
