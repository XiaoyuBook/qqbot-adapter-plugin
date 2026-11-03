import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload, FakeTimers, png } from './helpers.js';
import { AdapterError } from '../src/errors.js';

test('Markdown, native keyboards and picture cards send their documented bodies without text field conflicts', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  assert.ok((await e.reply([
    e.bot.segment.markdown('# 原生 Markdown\n**测试**'),
    e.bot.segment.button([{ text: '查询', input: '#uid' }])
  ])).message_id);
  const md = f.api.calls[0].body;
  assert.equal(md.msg_type, 2); assert.equal(md.markdown.content, '# 原生 Markdown\n**测试**'); assert.equal(md.content, undefined);
  assert.equal(md.keyboard.content.rows[0].buttons[0].action.type, 2); assert.equal(md.keyboard.content.rows[0].buttons[0].action.data, '#uid');
  assert.ok((await e.reply(e.bot.segment.card({ type: 'tuwen', content: { title: '测试卡片', description: '说明', url: 'https://example.test/article', pic_url: 'https://example.test/cover.png' } }))).message_id);
  assert.equal(f.api.calls[1].body.msg_type, 8); assert.equal(f.api.calls[1].body.card.content.title, '测试卡片');
  assert.equal(f.api.calls[1].body.content, undefined);
});

test('group member mentions use platform OpenID in Markdown; everyone uses the current native tag', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  await e.reply([{ type: 'at', qq: 'qqbot:123456:group-user:other-member' }, ' hello *literal*']);
  assert.equal(f.api.calls[0].body.msg_type, 2);
  assert.match(f.api.calls[0].body.markdown.content, /^<qqbot-at-user id="other-member" \/>/);
  assert.match(f.api.calls[0].body.markdown.content, /\\\*literal\\\*/);
  await e.reply('announcement', false, { at: 'all' });
  assert.match(f.api.calls[1].body.markdown.content, /^<qqbot-at-everyone \/>/);
  const p = await f.mapper.dispatch(payload('c2c'));
  assert.equal(await p.reply([{ type: 'at', qq: 'all' }, 'not valid in private chat']), false);
  assert.equal(p.qqbot.lastError.code, 'UNSUPPORTED_MESSAGE');
});

test('quotes use message-scene index or known sent ref_idx and never leak the scene auth token', async () => {
  const f = fixture();
  const e = await f.mapper.dispatch(payload('group', { message_scene: { ext: ['msg_idx=REFIDX_original==', 'ref_msg_idx=REFIDX_previous==', 'auth_token=FAKE_SCENE_SECRET'] } }));
  const original = f.api.request;
  f.api.request = async (...args) => ({ ...await original(...args), ext_info: { ref_idx: 'REFIDX_sent==' } });
  const first = await e.reply('reply with native quote', true);
  assert.equal(first.ref_idx, 'REFIDX_sent=='); assert.deepEqual(f.api.calls[0].body.message_reference, { message_id: 'REFIDX_original==' });
  assert.equal(first.warnings, undefined); assert.equal(e.source.ref_idx, 'REFIDX_previous==');
  await e.reply('quote previous response', { message_id: first.message_id });
  assert.equal(f.api.calls[1].body.message_reference.message_id, 'REFIDX_sent==');
  assert.equal(JSON.stringify([e.qqbot, f.api.calls, f.logger.records]).includes('FAKE_SCENE_SECRET'), false);
});

test('real DELETE recall has two-minute limit, singleflight and no passive quota or fake failure success', async () => {
  let now = Date.now(); const f = fixture({}, { now: () => now }), e = await f.mapper.dispatch(payload());
  const sent = await e.reply('temporary');
  assert.deepEqual(await Promise.all([e.group.recallMsg(sent.message_id), e.group.recallMsg(sent.message_id)]), [true, true]);
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(await e.group.recallMsg(sent.message_id), true); assert.equal(f.api.calls.length, 2);
  const next = await e.reply('another message'); now += 120001;
  assert.equal(await e.group.recallMsg(next.message_id), false); assert.equal(e.qqbot.lastError.code, 'RECALL_EXPIRED');
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1);
  now -= 120001; f.api.request = async () => { throw new AdapterError('PERMISSION_REQUIRED', { platformCode: 40062003 }); };
  assert.equal(await e.group.recallMsg(next.message_id), false); assert.equal(e.qqbot.lastError.code, 'PERMISSION_REQUIRED');
});

test('timer recall options are handled once and cancelled on account shutdown', async () => {
  const timers = new FakeTimers(), f = fixture({}, { timers }), e = await f.mapper.dispatch(payload());
  const base = e.reply; e.reply = (message, quote) => base(message, quote);
  await e.reply('short lived', false, { recallMsg: 10 });
  assert.equal(f.registry.timerHandles.size, 1); await timers.tick(10000);
  assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1);
  await e.reply('cancel pending recall', false, { recallMsg: 10 }); f.registry.dispose();
  await timers.tick(10000); assert.equal(f.api.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('C2C has four replies and sixty-minute context while group respects its shorter window', async () => {
  const f = fixture();
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const e = await f.mapper.dispatch(payload('c2c', { timestamp: old })); assert.ok(e);
  for (let i = 0; i < 4; i++) assert.ok((await e.reply('ok')).message_id);
  assert.equal(await e.reply('fifth'), false); assert.equal(e.qqbot.lastError.code, 'REPLY_LIMIT');
  assert.equal(await f.mapper.dispatch(payload('group', { timestamp: old })), false);
});

test('event-local account sends survive async interleaving and never borrow another event context', async () => {
  const f = fixture(), tasks = [];
  f.bot.on('message', e => tasks.push((async () => { await Promise.resolve(); return e.bot.pickGroup(e.group_id).sendMsg(e.message_id); })()));
  const first = await f.mapper.dispatch(payload('group', { id: 'first', group_openid: 'group-a' }));
  await f.mapper.dispatch(payload('group', { id: 'second', group_openid: 'group-b' })); await Promise.all(tasks);
  assert.equal(f.api.calls[0].route, '/v2/groups/group-a/messages'); assert.equal(f.api.calls[0].body.msg_id, 'first');
  assert.equal(f.api.calls[1].route, '/v2/groups/group-b/messages'); assert.equal(f.api.calls[1].body.msg_id, 'second');
  assert.throws(() => first.bot.pickGroup(first.group_id).sendMsg('outside event'), { code: 'PASSIVE_ONLY' });
});

test('proactive sending is explicit opt-in, separate from passive IDs and respects offline state', async () => {
  const f = fixture({ allowProactive: true }), e = await f.mapper.dispatch(payload());
  const result = await e.bot.sendGroupMsg(e.group_id, 'scheduled notice'); assert.ok(result.message_id);
  assert.equal(f.api.calls[0].body.msg_id, undefined); assert.equal(f.api.calls[0].body.event_id, undefined); assert.equal(f.api.calls[0].body.msg_seq, undefined);
  f.registry.setOnline(false); assert.throws(() => e.bot.sendGroupMsg(e.group_id, 'offline'), { code: 'OFFLINE' });
});

test('legacy segment bridge produces native buttons only in this adapter event and restores originals', async () => {
  const original = () => 'legacy no-op', segment = { button: original };
  const f = fixture({}, { segment }), tasks = [];
  assert.equal(segment.button(), 'legacy no-op');
  f.bot.on('message', e => tasks.push((async () => { await Promise.resolve(); return e.reply(['说明', segment.button([{ text: '查询', callback: '#uid' }])]); })()));
  await f.mapper.dispatch(payload()); await Promise.all(tasks);
  assert.equal(f.api.calls[0].body.msg_type, 2); assert.equal(f.api.calls[0].body.keyboard.content.rows[0].buttons[0].action.type, 2);
  assert.equal(segment.button(), 'legacy no-op'); f.registry.dispose(); assert.equal(segment.button, original);
});

test('legacy navigation attached to media results omits its whitespace and extra reply', async t => {
  const segment = { button: () => '' }, f = fixture({}, { segment }), pending = [];
  t.after(() => f.registry.dispose());
  f.bot.on('message', e => pending.push(e.reply([
    { type: 'image', file: png }, '\n\n',
    segment.button([{ text: '记录', callback: '#原石' }, { text: '统计', callback: '#原石统计' }])
  ])));
  await f.mapper.dispatch(payload()); await Promise.all(pending);
  const messages = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 1); assert.equal(messages[0].body.msg_type, 7);
  assert.equal(messages[0].body.keyboard, undefined);
  assert.ok(pending.length);
});

test('legacy selection prompts retain their buttons and trim only surrounding caption whitespace', async t => {
  const segment = { button: () => '' }, f = fixture({}, { segment }), pending = [];
  t.after(() => f.registry.dispose());
  f.bot.on('message', e => pending.push(e.reply([
    { type: 'image', file: png }, '\n\n请选择角色\n',
    segment.button([{ text: '确认', callback: '#确认角色' }])
  ])));
  await f.mapper.dispatch(payload()); await Promise.all(pending);
  const messages = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 2);
  assert.equal(messages[1].body.markdown.content, '请选择角色');
  assert.equal(messages[1].body.keyboard.content.rows[0].buttons[0].action.data, '#确认角色');
});

test('explicit native keyboards attached to images are retained', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  await e.reply([{ type: 'image', file: png }, e.bot.segment.button([{ text: '确认', input: '#确认' }])]);
  const messages = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(messages.length, 2); assert.equal(messages[1].body.keyboard.content.rows[0].buttons[0].action.data, '#确认');
});

test('definite button-permission denial falls back once without leaking callback data or retrying ambiguous delivery', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload()), original = f.api.request;
  let attempts = 0;
  f.api.request = async (...args) => {
    attempts++;
    if (args[2]?.keyboard) throw new AdapterError('PERMISSION_REQUIRED', { platformCode: 304037, status: 403 });
    return original(...args);
  };
  const button = { id: 'private-callback', render_data: { label: '确认', style: 1 }, action: { type: 1, data: 'FAKE_PRIVATE_CALLBACK', permission: { type: 2 } } };
  const result = await e.reply([e.bot.segment.markdown('说明'), e.bot.segment.keyboard({ content: { rows: [{ buttons: [button] }] } })]);
  assert.ok(result.message_id); assert.equal(attempts, 2); assert.equal(f.api.calls[0].body.msg_seq, 1);
  assert.equal(f.api.calls[0].body.keyboard, undefined); assert.equal(JSON.stringify(f.api.calls).includes('FAKE_PRIVATE_CALLBACK'), false);
  assert.equal(result.warnings.includes('keyboard_unavailable_text_fallback'), true);
  await e.reply(e.bot.segment.button([{ text: '查询', input: '#uid' }])); assert.equal(attempts, 3);
  const other = fixture(), event = await other.mapper.dispatch(payload()); let unknownSends = 0;
  other.api.request = async () => { unknownSends++; throw new AdapterError('API_NETWORK'); };
  assert.equal(await event.reply(event.bot.segment.button([{ text: '查询', input: '#uid' }])), false);
  assert.equal(unknownSends, 1);
});
