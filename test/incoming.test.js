import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingMessage } from '../src/incoming.js';
import { fixture, payload } from './helpers.js';

const url = 'https://b23.tv/example';
const card = (jump = url, ark_type = 'miniapp') => ({ message_type: 3, content: '[分享卡片]', ark_data: { prompt: '#卡片提示', ark_type, ark_name: '分享', fields: { title: '#卡片标题', jump_url: jump, preview: 'https://example.test/cover.png' } } });
const message = patch => ({ ...payload('group', { content: '', ...patch }), t: 'GROUP_MESSAGE_CREATE' });
const textOf = event => event.message.filter(part => part.type === 'text').map(part => part.text).join('\n');
const dataOf = event => event.message.filter(part => part.type === 'json').map(part => JSON.parse(part.data));

test('standalone official cards preserve all JSON data without a mention or cover download', async t => {
  for (const kind of ['miniapp', 'video_share', 'feed', 'tuwen', 'future-card-type']) {
    const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
    const input = card(url, kind), e = await f.mapper.dispatch(message(input));
    assert.equal(e.atBot, false); assert.deepEqual(e.message, [{ type: 'json', data: JSON.stringify(input.ark_data) }]);
    assert.equal(e.raw_message, e.message[0].data); assert.equal(e.qqbot.incoming.cards, 1); assert.equal(e.qqbot.incoming.mappedCards, 1);
    assert.equal(f.api.calls.length, 0);
  }
});

test('card JSON works in legacy envelopes, C2C, serialized ARK and serialized card content', async t => {
  for (const scope of ['group', 'c2c']) {
    const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
    const input = card(), e = await f.mapper.dispatch({ ...payload(scope, { ...input, message_type: undefined }), t: scope === 'group' ? 'GROUP_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE' });
    assert.deepEqual(dataOf(e), [input.ark_data]); assert.equal(e.atBot, false); assert.equal(e.raw_message, e.message[0].data);
  }
  for (const patch of [{ ark_data: JSON.stringify(card().ark_data) }, { ark_data: undefined, content: JSON.stringify(card().ark_data) }]) {
    const result = incomingMessage(message({ ...card(), ...patch }).d, 'group');
    assert.deepEqual(JSON.parse(result.parts[0].data), card().ark_data);
  }
});

test('parallel elements preserve text, media, JSON and trailing text without adopting child roles', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(message({ message_type: 101, msg_elements: [
    { message_type: 0, content: '前文', author: { member_openid: '12345678901234567890123456789012', member_role: 'owner' }, attachments: [{ content_type: 'image/png', url: 'https://example.test/image.png' }] },
    { message_type: 101, msg_elements: [card(), { message_type: 0, content: '后文' }] },
    { message_type: 999, content: '#忽略', msg_elements: [card()] }
  ] }));
  assert.deepEqual(e.message.map(part => part.type), ['text', 'image', 'json', 'text']);
  assert.deepEqual(dataOf(e), [card().ark_data]); assert.equal(e.raw_message, '前文\n' + e.message[2].data + '\n后文');
  assert.equal(e.sender.role, 'member'); assert.equal(e.isMaster, false);
});

test('identical JSON cards are deduplicated while a separate text link retains the card contract', () => {
  const result = incomingMessage(message({ message_type: 101, content: url, msg_elements: [card(), card()] }).d, 'group');
  assert.deepEqual(result.parts.map(part => part.type), ['text', 'json']);
  assert.equal(result.parts[0].text, url); assert.equal(result.summary.cards, 2); assert.equal(result.summary.mappedCards, 1);
  const distinct = incomingMessage(message({ message_type: 101, msg_elements: [card(), card('https://example.test/other')] }).d, 'group');
  assert.equal(distinct.parts.length, 2);
});

test('quote and chat history never execute nested old JSON or text', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const quote = await f.mapper.dispatch(message({ message_type: 103, content: '#帮助', msg_elements: [card(), { content: '#旧指令' }], message_scene: { ext: ['ref_msg_idx=old-reference', 'auth_token=DO_NOT_EXPOSE'] } }));
  assert.equal(textOf(quote), '#帮助'); assert.deepEqual(dataOf(quote), []); assert.equal(quote.source.ref_idx, 'old-reference');
  const history = await f.mapper.dispatch(message({ id: 'history', message_type: 102, content: url, msg_elements: [card()] }));
  assert.deepEqual(history.message, []); assert.equal(history.raw_message, '');
  const nested = await f.mapper.dispatch(message({ id: 'parallel-history', message_type: 101, msg_elements: [
    { message_type: 103, content: url, msg_elements: [card()] }, { message_type: 102, content: url }, { message_type: 0, content: '#帮助' }
  ] }));
  assert.equal(textOf(nested), '#帮助'); assert.deepEqual(dataOf(nested), []); assert.equal(nested.qqbot.incoming.skippedHistory, 2);
  assert.equal(JSON.stringify([quote.qqbot, f.logger.records]).includes('DO_NOT_EXPOSE'), false);
});

test('malformed card JSON is ignored and payload fields are never interpreted as media or commands', () => {
  for (const ark_data of [null, [], 'invalid-json', '"scalar"', 123, true]) {
    const result = incomingMessage(message({ message_type: 3, content: '#帮助', ark_data }).d, 'group');
    assert.deepEqual(result.parts, []); assert.equal(result.summary.ignoredCards, 1);
  }
  for (const jump of ['javascript:alert(1)', 'file:///tmp/video', 'https://name:secret@example.test/', 'invalid-link']) {
    const result = incomingMessage(message(card(jump)).d, 'group');
    assert.deepEqual(result.parts.map(part => part.type), ['json']); assert.equal(JSON.parse(result.parts[0].data).fields.jump_url, jump);
  }
});

test('nested messages from other authors, bots and cross-scope identities cannot become current content', () => {
  const d = message({ message_type: 101, author: { member_openid: 'current', id: 'same-author-id' }, msg_elements: [
    { ...card(), author: { member_openid: 'another' } }, { ...card(), author: { bot: true } },
    { ...card(), author: { user_openid: 'current' } }, { ...card(), author: { id: 'another-id' } },
    { ...card(), author: { member_openid: 'current' } }, { message_type: 0, content: '同一作者', author: { id: 'same-author-id' } }
  ] }).d;
  const result = incomingMessage(d, 'group');
  assert.equal(result.summary.skippedAuthors, 4); assert.deepEqual(result.parts.map(part => part.type), ['json', 'text']);
});

test('nested text, depth, element and media budgets reject oversized or cyclic messages', () => {
  const cyclic = { message_type: 101 }; cyclic.msg_elements = [cyclic];
  const excessive = [
    { message_type: 101, msg_elements: Array.from({ length: 101 }, () => ({ content: 'x' })) },
    { message_type: 101, msg_elements: [cyclic] },
    { message_type: 101, content: 'x'.repeat(64000), msg_elements: [{ content: 'y' }] },
    { message_type: 101, content: 'x'.repeat(63999), msg_elements: [{ content: 'y' }] },
    { message_type: 101, content: 'x'.repeat(64000), msg_elements: [card()] },
    { message_type: 101, msg_elements: 'not-an-array' }, { message_type: 101, msg_elements: [null] },
    { message_type: 101, msg_elements: [{ attachments: Array(6).fill({}) }, { attachments: Array(5).fill({}) }] },
    { message_type: 101, msg_elements: [{ content: 123 }] }
  ];
  for (const patch of excessive) assert.throws(() => incomingMessage(message(patch).d, 'group'), { code: 'EVENT_INVALID' });
  assert.equal(incomingMessage(message({ content: 'x'.repeat(64000) }).d, 'group').parts[0].text.length, 64000);
});

test('card JSON has bounded size, object depth and node count without mutating its input', () => {
  const cyclic = {}; cyclic.self = cyclic;
  let deep = {}; for (let i = 0; i < 10; i++) deep = { next: deep };
  for (const ark_data of [cyclic, deep, { text: 'x'.repeat(64000) }, { list: Array(129).fill('x') }, { number: Infinity }, { missing: undefined }, { nodes: Array.from({ length: 12 }, () => Array(100).fill(null)) }, Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['field' + i, i]))]) {
    assert.throws(() => incomingMessage(message({ message_type: 3, ark_data }).d, 'group'), { code: 'EVENT_INVALID' });
  }
  const input = Object.freeze({ fields: Object.freeze({ custom: '保留' }) });
  assert.deepEqual(JSON.parse(incomingMessage(message({ message_type: 3, ark_data: input }).d, 'group').parts[0].data), input);
});

test('nested attachment validation retains HTTPS and unsupported-media behavior', () => {
  for (const url of ['http://example.test/image.png', 'https://name:secret@example.test/image.png', 'bad-url']) assert.throws(() => incomingMessage(message({ message_type: 101, msg_elements: [{ attachments: [{ content_type: 'image/png', url }] }] }).d, 'group'), { code: 'EVENT_INVALID' });
  assert.deepEqual(incomingMessage(message({ attachments: [{ content_type: 'unknown' }, null] }).d, 'group').unsupportedAttachments, ['unsupported', 'unsupported']);
});

test('card diagnostics contain fixed types and counts without payload values or identities', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  await f.mapper.dispatch(message({ ...card('https://b23.tv/PRIVATE?token=SECRET'), message_scene: { ext: ['auth_token=SCENE_SECRET'] } }));
  assert.deepEqual(f.logger.records, ['[qqbot-adapter-plugin] incoming_card type=3 cards=1 mapped=1 ignored=0 history=0 authors=0']);
  await f.mapper.dispatch(message({ id: 'bad', message_type: 3, ark_data: 'PRIVATE_INVALID_JSON' }));
  assert.equal(f.logger.records.at(-1), '[qqbot-adapter-plugin] incoming_card_schema ["string"]');
  assert.equal(/PRIVATE|SECRET/.test(JSON.stringify(f.logger.records)), false);
});

test('independent cards obey reception permissions and cross-event replay protection', async t => {
  const disabled = fixture(); t.after(() => disabled.registry.dispose()); assert.equal(await disabled.mapper.dispatch(message(card())), false);
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose()); let count = 0;
  f.bot.on('message', () => count++); const p = message(card());
  await f.mapper.dispatch(p); await f.mapper.dispatch(p); await f.mapper.dispatch({ ...p, t: 'GROUP_AT_MESSAGE_CREATE' }); assert.equal(count, 1);
});

test('platform mentions retain their position before attachments and card data cannot forge a mention', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose()); f.mapper.platformBotId = 'bot-id';
  const e = await f.mapper.dispatch(message({ content: '正文', mentions: [{ member_openid: 'another-member' }], attachments: [{ content_type: 'image/png', url: 'https://example.test/image.png' }] }));
  assert.deepEqual(e.message.map(part => part.type), ['text', 'at', 'image']);
  const json = await f.mapper.dispatch(message({ id: 'json-mention', ...card(), ark_data: { prompt: '<@bot-id> #帮助' } }));
  assert.equal(json.atBot, false); assert.equal(textOf(json), ''); assert.equal(json.message.some(part => part.type === 'at'), false);
});
