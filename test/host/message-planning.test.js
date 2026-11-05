import test from 'node:test';
import assert from 'node:assert/strict';
import { segment } from 'icqq';
import { harness } from './harness.js';
import { createContractProbe } from './contract-probe.js';
import { payload, png, FakeTimers } from '../helpers.js';
import { AdapterError } from '../../src/errors.js';

const recalls = f => [...f.registry.timers.jobs.values()].filter(job => job.at - f.registry.timers.time === 10000).length;
const sent = f => f.api.calls.filter(c => c.route.endsWith('/messages') && c.method === 'POST');
async function run(t, exercise, { scope = 'group', adapterConfig = {}, name = 'planning-probe', command = '#contract', setup = () => {} } = {}) {
  const f = await harness(t, { adapterConfig, timers: new FakeTimers() }); const rows = [];
  await setup(f);
  const Probe = createContractProbe(f.Plugin, { Bot: f.bot, name, pattern: `^${command}$`, exercise,
    onResult: row => rows.push(row) });
  await f.loader.loadPlugin({ name }, Probe);
  const event = await f.mapper.dispatch(payload(scope, { content: command })); await f.flush();
  assert.equal(rows.length, 1, f.logger.records.join('\n'));
  return { f, event, result: rows[0].result };
}

test('public planning: a plugin reply wrapper receives all options after the real host wrapper', async t => {
  let received;
  const { f, result } = await run(t, async ({ event: e }) => {
    const base = e.reply;
    e.reply = (message, quote = false, extra = {}) => { received = extra; return base(message, quote, extra); };
    return e.reply(png, false, { at: false, recallMsg: 10, receipt: true });
  }, { adapterConfig: { mentionBeforeImage: true } });
  assert.deepEqual(received, { at: false, recallMsg: 10, receipt: true });
  assert.equal(result.ok, true); assert.equal(sent(f)[0].body.msg_type, 7);
  assert.equal(f.registry.timerHandles.size, 1);
});

test('public planning: global and account button constructors preserve an image confirmation', async t => {
  for (const source of ['global', 'account']) {
    const { f, result } = await run(t, ({ event: e }) => e.reply([png,
      (source === 'global' ? segment : e.bot.segment).button([{ text: 'Confirm', input: '#confirm' }])]),
      { name: `${source}-button`, adapterConfig: { mentionBeforeImage: true } });
    assert.equal(result.ok, true);
    assert.equal(sent(f).at(-1).body.keyboard.content.rows[0].buttons[0].action.data, '#confirm');
    assert.equal(result.warnings?.includes('legacy_navigation_omitted') ?? false, false);
  }
});

test('public planning: explicit group self mentions survive both element and option forms', async t => {
  for (const form of ['element', 'option']) {
    const { f, result } = await run(t, ({ event: e }) => e.reply(
      form === 'element' ? [segment.at(e.user_id), 'Answer'] : 'Answer', false,
      form === 'option' ? { at: true, receipt: true } : { receipt: true }));
    assert.equal(result.ok, true); assert.match(sent(f)[0].body.markdown.content, /<qqbot-at-user id="12345678901234567890123456789012" \/>/);
  }
});

test('public planning: numeric mapped QQ at options resolve through trusted identity mapping', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply('Answer', false, { at: 10001, receipt: true }),
    { adapterConfig: { userIdMappings: { 'qqbot:123456:group-user:12345678901234567890123456789012': '10001' } } });
  assert.equal(result.ok, true); assert.match(sent(f)[0].body.markdown.content, /id="12345678901234567890123456789012"/);
});

test('public planning: forward nodes keep their own keyboards and ordered content', async t => {
  const { f, result } = await run(t, async ({ event: e }) => e.reply(await e.bot.makeForwardMsg([
    { nickname: 'One', message: ['first', e.bot.segment.button([{ text: 'One', input: '#one' }])] },
    { nickname: 'Two', message: ['second', e.bot.segment.button([{ text: 'Two', input: '#two' }])] }
  ]), false, { receipt: true }));
  assert.equal(result.ok, true); assert.equal(sent(f).length, 2);
  assert.match(sent(f)[0].body.markdown.content, /first/); assert.doesNotMatch(sent(f)[0].body.markdown.content, /second/);
  assert.deepEqual(sent(f).map(c => c.body.keyboard.content.rows[0].buttons[0].action.data), ['#one', '#two']);
  assert.equal(result.message_ids.length, 2);
});


test('public planning: nested wrappers inherit omitted and empty options and merge explicit field overrides', async t => {
  for (const forwarding of ['omitted', 'empty', 'override']) {
    const received = [];
    const { f, result } = await run(t, async ({ event: e }) => {
      const host = e.reply;
      e.reply = (m, q, extra = {}) => { received.push(extra); return forwarding === 'omitted' ? host(m, q) : host(m, q, forwarding === 'empty' ? {} : { recallMsg: 0 }); };
      const inner = e.reply;
      e.reply = async (m, q, extra = {}) => { await Promise.resolve(); received.push(extra); return inner(m, q, extra); };
      return e.reply(png, false, { at: false, recallMsg: 10, receipt: true });
    }, { name: 'wrapper-' + forwarding, adapterConfig: { mentionBeforeImage: true } });
    assert.deepEqual(received, Array(2).fill({ at: false, recallMsg: 10, receipt: true }));
    assert.equal(result.ok, true); assert.equal(sent(f)[0].body.msg_type, 7);
    assert.equal(recalls(f), forwarding === 'override' ? 0 : 1);
    assert.equal(f.registry.timerHandles.size, recalls(f));
    await f.registry.timers.tick(10000);
    assert.equal(f.api.calls.filter(c => c.method === 'DELETE' && c.route.includes('/messages/')).length, forwarding === 'override' ? 0 : 1);
  }
});

test('public planning: options stay isolated across concurrent calls through async plugin wrappers', async t => {
  const { f, result } = await run(t, async ({ event: e }) => {
    const base = e.reply;
    e.reply = async (m, q, extra = {}) => { await Promise.resolve(); return base(m, q, extra); };
    return Promise.all([e.reply(png, false, { at: false, recallMsg: 10 }), e.reply(png, false, { recallMsg: 0 })]);
  }, { adapterConfig: { mentionBeforeImage: true } });
  assert.ok(result.every(r => r.ok)); assert.deepEqual(sent(f).map(c => c.body.msg_type), [7, 2]);
  assert.deepEqual(result.map(r => r.total_parts), [1, 1]);
  assert.equal(recalls(f), 1); assert.equal(f.registry.timerHandles.size, 1);
});

test('public planning: a separate contact send inside a wrapper does not inherit reply options', async t => {
  const { f, result } = await run(t, async ({ event: e }) => {
    const base = e.reply;
    e.reply = async (m, q, extra = {}) => { await e.group.sendMsg(png); return base(m, q, extra); };
    return e.reply(png, false, { at: false, recallMsg: 10 });
  }, { adapterConfig: { mentionBeforeImage: true } });
  assert.equal(result.ok, true); assert.deepEqual(sent(f).map(c => c.body.msg_type), [2, 7]);
  assert.equal(recalls(f), 1); assert.equal(f.registry.timerHandles.size, 1);
});

test('public planning: invalid options are rejected before plugin wrappers can erase them', async t => {
  let calls = 0;
  const { result } = await run(t, ({ event: e }) => {
    const base = e.reply; e.reply = (m, q) => { calls++; return base(m, q); };
    return e.reply('must reject', false, { receipt: true, recallMsg: -1 });
  });
  assert.equal(calls, 0); assert.equal(result.status, 'rejected'); assert.equal(result.failure.code, 'UNSUPPORTED_OPTIONS');
});


for (const id of [10001, '10001', 'qqbot:123456:group-user:12345678901234567890123456789012']) test('public planning: trusted mention identity resolves ' + typeof id + ' ' + String(id).slice(0, 20), async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply('answer', false, { at: id, receipt: true }), {
    adapterConfig: { userIdMappings: { 'qqbot:123456:group-user:12345678901234567890123456789012': '10001' } }
  });
  assert.equal(result.ok, true); assert.match(sent(f)[0].body.markdown.content, /id="12345678901234567890123456789012"/);
});

for (const id of [10002, '10002', 'qqbot:999999:group-user:someone', 'qqbot:123456:c2c-user:someone', 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) test('public planning: invalid or foreign mention identity is refused ' + String(id), async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply('never deliver', false, { at: id, receipt: true }));
  assert.equal(result.ok, false); assert.equal(result.status, 'rejected'); assert.deepEqual(result.message_ids, []);
  assert.equal(sent(f).some(c => c.body.content === 'never deliver' || c.body.markdown?.content.includes('never deliver')), false);
});

test('public planning: a trusted private identity never supplies group mention rights', async t => {
  const { result } = await run(t, ({ event: e }) => e.reply('answer', false, { at: 10001, receipt: true }), {
    adapterConfig: { userIdMappings: { 'qqbot:123456:c2c-user:c2c-openid': '10001' } }
  });
  assert.equal(result.ok, false); assert.equal(result.failure.code, 'OPERATION_INVALID');
});

test('public planning: explicit sender aliases and automatic image mention produce one mention above one image', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply([segment.at(10001), e.bot.segment.at(e.qqbot.principalId), 'caption', png], false, { at: true }), {
    adapterConfig: { mentionBeforeImage: true, userIdMappings: { 'qqbot:123456:group-user:12345678901234567890123456789012': '10001' } }
  });
  assert.equal(result.ok, true); assert.equal(result.total_parts, 1); assert.equal(sent(f).length, 1);
  const content = sent(f)[0].body.markdown.content;
  assert.equal(content.match(/<qqbot-at-user/g).length, 1); assert.match(content, /^<qqbot-at-user[^\n]+\ncaption\n!\[图片/);
  assert.equal(f.api.materials.size, 0);
});

test('public planning: explicit mentions remain when automatic image mention is disabled', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply([e.bot.segment.at(e.user_id), png], false, { at: false }));
  assert.equal(result.ok, true); assert.equal(sent(f).length, 1); assert.match(sent(f)[0].body.markdown.content, /^<qqbot-at-user[^\n]+\n!\[图片/);
});

test('public planning: an explicit mention of a URL image stays visible when combined image layout is unavailable', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply([e.bot.segment.at(e.user_id), { type: 'image', file: 'https://example.test/no-dimensions.png' }]), { adapterConfig: { mentionBeforeImage: true } });
  assert.equal(result.ok, true); assert.equal(result.total_parts, 2);
  assert.deepEqual(sent(f).map(c => c.body.msg_type), [2, 7]); assert.match(sent(f)[0].body.markdown.content, /<qqbot-at-user/);
});

for (const form of ['element', 'option']) test('public planning: private self mention degrades with a warning via ' + form, async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply(form === 'element' ? [segment.at(e.user_id), 'private'] : 'private', false, form === 'option' ? { at: true } : {}), { scope: 'c2c' });
  assert.equal(result.ok, true); assert.equal(sent(f)[0].body.content, 'private'); assert.ok(result.warnings.includes('private_self_mention_omitted'));
});

for (const source of ['global', 'account']) test('public planning: only an explicit option hides navigation from ' + source + ' buttons', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply([png, '\n\n', (source === 'global' ? segment : e.bot.segment).button([{ text: 'Choice', input: '#choose' }])], false, { button: false }));
  assert.equal(result.ok, true); assert.equal(result.total_parts, 1); assert.equal(sent(f)[0].body.msg_type, 7); assert.equal(sent(f).length, 1);
  assert.ok(result.warnings.includes('keyboard_omitted_by_option'));
});

for (const style of ['direct', 'nested', 'forward']) test('public planning: each content block owns its keyboard in ' + style + ' input', async t => {
  const { f, result } = await run(t, async ({ event: e }) => {
    const one = ['one', e.bot.segment.button([{ text: 'One', input: '#one' }])], two = ['two', segment.button([{ text: 'Two', input: '#two' }])];
    const message = style === 'direct' ? [...one, ...two] : style === 'nested' ? [one, [two]] : await e.bot.makeForwardMsg({ message: await e.bot.makeForwardMsg([{ message: one }, { message: two }]) });
    return e.reply(message, false, { receipt: true });
  });
  assert.equal(result.ok, true); assert.equal(result.total_parts, 2); assert.equal(result.completed_parts, 2);
  assert.deepEqual(sent(f).map(c => c.body.keyboard.content.rows[0].buttons[0].action.data), ['#one', '#two']);
  assert.match(sent(f)[0].body.markdown.content, /one/); assert.doesNotMatch(sent(f)[0].body.markdown.content, /two/); assert.match(sent(f)[1].body.markdown.content, /two/);
});

for (const scope of ['group', 'c2c']) for (const entry of ['reply', 'event-contact', 'pick']) test('public planning: common normalization via ' + scope + ' ' + entry, async t => {
  const { f, result } = await run(t, async ({ event: e, contact }) => {
    const send = entry === 'reply' ? e.reply : entry === 'pick' ? contact.sendMsg : (e.group ?? e.friend).sendMsg;
    return send([['first', segment.button([{ text: 'First', input: '#first' }])], ['second', e.bot.segment.button([{ text: 'Second', input: '#second' }])]], false, { recallMsg: 10, receipt: true });
  }, { scope, name: 'caller-' + entry, command: '#different' });
  assert.equal(result.ok, true); assert.equal(result.total_parts, 2); assert.equal(result.message_ids.length, 2); assert.equal(f.registry.timerHandles.size, 2);
  assert.deepEqual(sent(f).map(c => c.body.msg_seq), [1, 2]); assert.ok(sent(f).every(c => c.body.msg_id === 'trigger-id'));
});

for (const scope of ['group', 'c2c']) test('public planning: permitted proactive contacts use the same planner in ' + scope, async t => {
  const { f, result: contact } = await run(t, ({ contact }) => contact, { scope, adapterConfig: { allowProactive: true } });
  const result = await contact.sendMsg([['first', { type: 'button', data: [{ text: 'First', input: '#first' }] }], ['second', { type: 'button', data: [{ text: 'Second', input: '#second' }] }]], false, { recallMsg: 10, receipt: true });
  assert.equal(result.ok, true); assert.equal(result.total_parts, 2); assert.equal(f.registry.timerHandles.size, 2);
  assert.ok(sent(f).every(c => c.body.msg_id === undefined && c.body.msg_seq === undefined));
});

test('public planning: forward quota is checked before any image upload or message delivery', async t => {
  const { f, result } = await run(t, async ({ event: e }) => e.reply(await e.bot.makeForwardMsg(Array.from({ length: 6 }, (_, i) => ({ message: [png, e.bot.segment.button([{ text: 'Choose', input: '#choose' + i }])] }))), false, { receipt: true }));
  assert.equal(result.ok, false); assert.equal(result.failure.code, 'REPLY_LIMIT'); assert.ok(result.total_parts > 5);
  assert.equal(f.api.uploads.length, 0); assert.equal(sent(f).length, 0); assert.equal(f.api.calls.some(c => c.route.endsWith('/files') || c.route.endsWith('/prepare')), false);
});

test('public planning: button permission fallback preserves every node order and receipt', async t => {
  let denied = 0;
  const { f, result } = await run(t, ({ event: e }) => e.reply(['first', e.bot.segment.button([{ text: 'First', input: '#first' }]), 'second', e.bot.segment.button([{ text: 'Second', input: '#second' }])]), { setup(f) {
    const request = f.api.request.bind(f.api); f.api.request = async (...args) => { if (args[2]?.keyboard) { denied++; throw new AdapterError('PERMISSION_REQUIRED', { status: 403, platformCode: 304037 }); } return request(...args); };
  } });
  assert.equal(result.ok, true); assert.equal(denied, 1); assert.equal(result.completed_parts, 2); assert.equal(result.message_ids.length, 2);
  assert.deepEqual(sent(f).map(c => c.body.msg_seq), [1, 2]); assert.match(sent(f)[0].body.markdown.content, /#first/); assert.match(sent(f)[1].body.markdown.content, /#second/);
});

for (const failure of ['denied', 'unknown']) test('public planning: stop at ' + failure + ' and retain earlier node receipts and recall', async t => {
  let posts = 0;
  const { f, result } = await run(t, ({ event: e }) => e.reply(['first', e.bot.segment.button([{ text: 'First', input: '#first' }]), 'second', e.bot.segment.button([{ text: 'Second', input: '#second' }]), 'third'], false, { recallMsg: 10, receipt: true }), { setup(f) {
    const request = f.api.request.bind(f.api); f.api.request = async (...args) => { if (args[1].endsWith('/messages') && ++posts === 2) throw new AdapterError(failure === 'unknown' ? 'API_NETWORK' : 'PERMISSION_REQUIRED', { status: 403 }); return request(...args); };
  } });
  assert.equal(posts, 2); assert.equal(result.status, 'partial'); assert.equal(result.total_parts, 3); assert.equal(result.completed_parts, 1); assert.equal(result.message_ids.length, 1);
  assert.equal(result.failure.delivery, failure === 'unknown' ? 'unknown' : 'rejected'); assert.equal(result.failure.part_index, 1); assert.equal(f.registry.timerHandles.size, 1);
  await f.registry.timers.tick(10000); assert.equal(f.api.calls.filter(c => c.method === 'DELETE' && c.route.includes('/messages/')).length, 1);
});


test('public planning: detailed receipt preference survives an invalid nested override', async t => {
  const { result } = await run(t, ({ event: e }) => {
    const base = e.reply; e.reply = (m, q) => base(m, q, { recallMsg: -1 });
    return e.reply('invalid', false, { receipt: true });
  });
  assert.equal(result.status, 'rejected'); assert.equal(result.failure.code, 'UNSUPPORTED_OPTIONS');
});

test('public planning: options are snapshotted and do not leak into another event', async t => {
  const { f, result } = await run(t, async ({ event: e }) => {
    const extra = { at: false, recallMsg: 10 };
    const pending = e.reply(png, false, extra); extra.at = true; extra.recallMsg = 0;
    return pending;
  }, { adapterConfig: { mentionBeforeImage: true } });
  assert.equal(result.ok, true); assert.equal(sent(f)[0].body.msg_type, 7); assert.equal(f.registry.timerHandles.size, 1);
  const other = await f.mapper.dispatch(payload('c2c', { id: 'another-trigger', content: '#contract' })); await f.flush();
  assert.notEqual(other.message_id, 'trigger-id'); assert.equal(sent(f).at(-1).body.msg_id, 'another-trigger');
});

test('public planning: a malformed later keyboard preflights the whole call', async t => {
  const { f, result } = await run(t, ({ event: e }) => e.reply(['first', e.bot.segment.button([{ text: 'First', input: '#first' }]), png, e.bot.segment.keyboard({ content: { rows: [] } })], false, { receipt: true }));
  assert.equal(result.status, 'rejected'); assert.equal(result.completed_parts, 0); assert.equal(result.failure.code, 'UNSUPPORTED_OPTIONS');
  assert.equal(f.api.uploads.length, 0); assert.equal(sent(f).some(c => c.body.keyboard), false);
});

test('public planning: recursive direct arrays are rejected without delivering any business content', async t => {
  const { result } = await run(t, ({ event: e }) => { const cycle = ['not sent']; cycle.push(cycle); return e.reply(cycle, false, { receipt: true }); });
  assert.equal(result.ok, false); assert.equal(result.failure.code, 'UNSUPPORTED_MESSAGE'); assert.deepEqual(result.message_ids, []);
});

test('public planning: an uncertain later image preserves earlier receipts and defers only its own material cleanup', async t => {
  let posts = 0;
  const { f, result } = await run(t, ({ event: e }) => e.reply([png, e.bot.segment.button([{ text: 'First', input: '#first' }]), png, e.bot.segment.button([{ text: 'Second', input: '#second' }])], false, { recallMsg: 10, receipt: true }), { adapterConfig: { mentionBeforeImage: true }, setup(f) {
    const request = f.api.request.bind(f.api); f.api.request = async (...args) => { const answer = await request(...args); if (args[1].endsWith('/messages') && ++posts === 3) throw new AdapterError('API_NETWORK'); return answer; };
  } });
  assert.equal(posts, 3); assert.equal(result.status, 'partial'); assert.equal(result.total_parts, 4); assert.equal(result.completed_parts, 2);
  assert.equal(result.failure.delivery, 'unknown'); assert.equal(result.failure.stage, 'message'); assert.equal(f.registry.timerHandles.size, 2);
  assert.equal(f.api.materials.size, 1); assert.equal(f.api.calls.filter(c => c.method === 'DELETE' && c.route.startsWith('/v2/media-images/')).length, 1);
  await f.registry.timers.tick(10000); assert.equal(f.api.calls.filter(c => c.method === 'DELETE' && c.route.includes('/messages/')).length, 2);
  await f.registry.timers.tick(290000); assert.equal(f.api.materials.size, 0); assert.equal(posts, 3);
});
