import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDeduplicator } from '../src/events.js';
import { AccountRegistry } from '../src/accounts.js';
import { AdapterController } from '../src/controller.js';
import { fixture, payload, host, config, fakeApi } from './helpers.js';

test('group @ maps namespaced IDs, sender, member and reply, exactly one root dispatch', async () => {
  const f = fixture(); const names = []; const emit = f.bot.emit.bind(f.bot); f.bot.emit = (name, e) => { names.push(name); return emit(name, e); };
  const event = await f.mapper.dispatch(payload());
  assert.equal(event.self_id, 'qqbot:123456'); assert.equal(event.bot, f.registry.account);
  assert.equal(event.user_id, 'qqbot:123456:group-user:12345678901234567890123456789012'); assert.equal(Number.isNaN(Number(event.user_id)), true);
  assert.equal(event.group_id, 'qqbot:123456:group:group-openid'); assert.equal(event.message_type, 'group'); assert.equal(event.post_type, 'message'); assert.equal(event.atBot, true);
  assert.equal(event.message[0].qq, event.self_id); assert.equal(event.member.is_admin, false); assert.equal(event.member.is_owner, false); assert.equal(event.group.pickMember(event.user_id), event.member);
  assert.deepEqual(names, ['message']); assert.equal(f.bot.uin, 88888); await event.reply('hello');
  assert.equal(f.api.calls[0].route, '/v2/groups/group-openid/messages'); assert.equal(f.api.calls[0].body.msg_id, 'trigger-id');
});
test('C2C mapping keeps scope and OpenID, e.friend.sendMsg uses same passive context', async () => {
  const f = fixture(); const e = await f.mapper.dispatch(payload('c2c'));
  assert.equal(e.message_type, 'private'); assert.equal(e.group, undefined); assert.equal(e.qqbot.userOpenid, 'c2c-openid');
  assert.equal(e.user_id, 'qqbot:123456:c2c-user:c2c-openid'); await e.friend.sendMsg('one'); await e.reply('two');
  assert.deepEqual(f.api.calls.map(c => c.body.msg_seq), [1, 2]);
  assert.throws(() => f.registry.account.pickFriend(e.user_id).sendMsg('proactive'), { code: 'PASSIVE_ONLY' });
});
test('only leading own READY mention stripped, other mentions/text preserved', async () => {
  const f = fixture(); f.mapper.platformBotId = 'bot-id';
  const e = await f.mapper.dispatch(payload('group', { content: ' <@!bot-id> #test <@other>' }));
  assert.equal(e.raw_message, '#test <@other>');
});
test('OpenID authorization is local, scoped, no QQ self-claim or masterQQ escalation', async () => {
  const user = '12345678901234567890123456789012';
  const f = fixture({ masterGroupOpenids: [user] });
  const group = await f.mapper.dispatch(payload()); assert.equal(group.isMaster, true); group.isMaster = false; assert.equal(group.isMaster, true);
  const c2c = await f.mapper.dispatch(payload('c2c', { author: { user_openid: user }, content: '#绑定 10001' }));
  c2c.isMaster = true; assert.equal(c2c.isMaster, false);
  const stranger = await f.mapper.dispatch(payload('group', { id: 'claim', author: { member_openid: '10001' }, content: '#我是主人 10001' }));
  stranger.isMaster = true; assert.equal(stranger.isMaster, false); assert.equal(stranger.user_id, 'qqbot:123456:group-user:10001');
});
test('dedup before dispatch across gateway sequences, within and between targets/scopes', async () => {
  const f = fixture(); let count = 0; f.bot.on('message', () => count++);
  const event = payload(); await Promise.all([f.mapper.dispatch(event), f.mapper.dispatch({ ...event, s: 99 }), f.mapper.dispatch(event)]);
  assert.equal(count, 1);
  await f.mapper.dispatch(payload('group', { group_openid: 'different-group' })); await f.mapper.dispatch(payload('c2c'));
  assert.equal(count, 3);
});
test('unknown events, disabled scopes, whitelist and offline do not dispatch', async () => {
  const f = fixture({ receiveGroup: false, allowedC2COpenids: ['allowed'] }); let count = 0; f.bot.on('message', () => count++);
  assert.equal(await f.mapper.dispatch(payload()), false); assert.equal(await f.mapper.dispatch(payload('c2c')), false);
  assert.equal(await f.mapper.dispatch({ ...payload(), t: 'GROUP_MESSAGE_CREATE' }), false);
  f.registry.setOnline(false); assert.equal(await f.mapper.dispatch(payload('c2c', { author: { user_openid: 'allowed' } })), false); assert.equal(count, 0);
});
test('malformed IDs and timestamps rejected; stale replays never get fresh reply rights', async () => {
  const f = fixture();
  for (const patch of [{ author: { member_openid: 123 } }, { group_openid: '../x' }, { timestamp: 'not-date' }, { id: 123 }, { timestamp: new Date(Date.now() + 120000).toISOString() }]) await assert.rejects(f.mapper.dispatch(payload('group', patch)), { code: 'EVENT_INVALID' });
  assert.equal(await f.mapper.dispatch(payload('group', { timestamp: new Date(Date.now() - 300000).toISOString() })), false);
});
test('incoming image, voice, video and file attachments map to their native elements', async () => {
  const f = fixture();
  const image = await f.mapper.dispatch(payload('c2c', { attachments: [{ content_type: 'image/png', url: '//example.test/image.png' }] }));
  assert.equal(image.message.at(-1).url, 'https://example.test/image.png');
  for (const [mime, type] of [['voice', 'record'], ['video/mp4', 'video'], ['file', 'file']]) {
    const e = await f.mapper.dispatch(payload('group', { id: type, content: '', attachments: [{ content_type: mime, url: 'https://example.test/media', filename: 'sample', asr_refer_text: 'test voice' }] }));
    assert.equal(e.message.at(-1).type, type);
  }
  assert.equal(f.api.calls.length, 0);
});
test('bounded replay cache expires and cannot grow without bound', () => {
  let now = 0; const dedup = new EventDeduplicator({ now: () => now, max: 2, ttlMs: 100 });
  assert.equal(dedup.claim('a'), true); assert.equal(dedup.claim('a'), false); dedup.claim('b'); assert.equal(dedup.claim('c'), false); assert.equal(dedup.seen.size, 2); assert.equal(dedup.claim('a'), false);
  now = 101; assert.equal(dedup.claim('b'), true); assert.equal(dedup.seen.size, 1);
});
test('NapCat load orders/reconnect/default ID coexist; remove only own account', () => {
  for (const order of ['qqbot-first', 'napcat-first']) {
    const bot = host(); const adapterArray = bot.adapter; const napcat = { uin: 10001, adapter: 'NapCat' };
    const ncConnect = () => { bot[10001] = napcat; if (!bot.adapter.includes(10001)) bot.adapter.push(10001); bot.uin = 10001; };
    if (order === 'napcat-first') ncConnect();
    const registry = new AccountRegistry(bot, config()); registry.register(); registry.setOnline(true);
    if (order === 'qqbot-first') { assert.equal(bot.uin, 88888); ncConnect(); }
    registry.setOnline(false); ncConnect(); registry.setOnline(true); registry.setOnline(true);
    assert.equal(bot.uin, 10001); assert.equal(bot[10001], napcat); assert.equal(bot.adapter, adapterArray); assert.equal(bot.adapter.filter(x => x === registry.id).length, 1);
    registry.dispose(); assert.deepEqual(bot.adapter, [10001]); assert.equal(bot[10001], napcat); assert.equal(bot.uin, 10001);
  }
});
test('registration cannot replace another account; stop cannot remove replaced account', () => {
  const bot = host(); const foreign = {}; bot['qqbot:123456'] = foreign;
  const registry = new AccountRegistry(bot, config()); assert.throws(() => registry.register(), { code: 'ACCOUNT_COLLISION' }); registry.dispose(); assert.equal(bot['qqbot:123456'], foreign);
});
test('empty/default config never constructs API/WS or opens ports; lifecycle idempotent', async () => {
  let constructed = 0;
  const disabled = new AdapterController({ host: host(), store: { read: async () => ({ config: config(), appSecret: '' }) }, apiFactory: () => { constructed++; } });
  await Promise.all([disabled.start(), disabled.start()]); assert.equal(constructed, 0); assert.equal(disabled.status.state, 'disabled'); await disabled.stop();
  let starts = 0, stops = 0;
  const enabled = new AdapterController({ host: host(), store: { read: async () => ({ config: config({ enabled: true }), appSecret: 'FAKE' }) }, apiFactory: fakeApi, transportFactory: options => ({ start() { starts++; options.onStatus({ state: 'online' }); }, stop() { stops++; options.onStatus({ state: 'stopped' }); } }) });
  await Promise.all([enabled.start(), enabled.start()]); assert.equal(starts, 1); await enabled.reload(); assert.equal(stops, 1); assert.equal(starts, 2); await enabled.stop(); await enabled.stop(); assert.equal(stops, 2);
});
