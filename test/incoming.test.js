import test from 'node:test';
import assert from 'node:assert/strict';
import { incomingMessage } from '../src/incoming.js';
import { fixture, payload } from './helpers.js';

const url = 'https://b23.tv/example';
const card = (jump = url, ark_type = 'miniapp') => ({ message_type: 3, content: '[分享卡片]', ark_data: { prompt: '#不应执行', ark_type, ark_name: '分享', fields: { jump_url: jump, title: '#不应执行', preview: 'https://example.test/cover.png' } } });
const message = patch => ({ ...payload('group', { content: '', ...patch }), t: 'GROUP_MESSAGE_CREATE' });
const textOf = event => event.message.filter(part => part.type === 'text').map(part => part.text).join('\n');

test('standalone official share cards map their jump link without a mention or cover download', async t => {
  for (const kind of ['miniapp', 'video_share', 'feed', 'tuwen', 'future-card-type']) {
    const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
    const e = await f.mapper.dispatch(message(card(url, kind)));
    assert.equal(e.atBot, false); assert.deepEqual(e.message, [{ type: 'text', text: url }]);
    assert.equal(e.raw_message, url); assert.equal(e.qqbot.incoming.cards, 1); assert.equal(e.qqbot.incoming.mappedCards, 1);
    assert.equal(e.message.some(part => part.type === 'image'), false); assert.equal(f.api.calls.length, 0);
  }
});

test('card fields also work in legacy envelopes and private messages', async t => {
  for (const scope of ['group', 'c2c']) {
    const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
    const e = await f.mapper.dispatch({ ...payload(scope, { ...card(), message_type: undefined }), t: scope === 'group' ? 'GROUP_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE' });
    assert.equal(textOf(e), url); assert.equal(e.atBot, false);
  }
});

test('parallel elements preserve current text, media and card order without adopting child roles', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(message({ message_type: 101, msg_elements: [
    { message_type: 0, content: '前文', author: { member_openid: '12345678901234567890123456789012', member_role: 'owner' }, attachments: [{ content_type: 'image/png', url: 'https://example.test/image.png' }] },
    { message_type: 101, msg_elements: [card(), { message_type: 0, content: '后文' }] },
    { message_type: 999, content: '#不应执行', msg_elements: [card('https://example.test/ignored')] }
  ] }));
  assert.deepEqual(e.message.map(part => part.type), ['text', 'image', 'text']);
  assert.equal(e.message[0].text, '前文'); assert.equal(e.message[2].text, url + '\n后文');
  assert.equal(e.raw_message, '前文\n' + url + '\n后文'); assert.equal(e.sender.role, 'member'); assert.equal(e.isMaster, false);
});

test('duplicated card links and links already in current text are emitted only once', () => {
  const d = message({ message_type: 101, content: '链接 ' + url, msg_elements: [card(), card('//b23.tv/example'), card('https://example.test/other'), card('https://example.test/other')] }).d;
  const result = incomingMessage(d, 'group');
  assert.deepEqual(result.parts, [{ type: 'text', text: '链接 ' + url + '\nhttps://example.test/other' }]);
  assert.equal(result.summary.cards, 4); assert.equal(result.summary.mappedCards, 1);
  const later = incomingMessage(message({ message_type: 101, msg_elements: [card(), { message_type: 0, content: url }] }).d, 'group');
  assert.deepEqual(later.parts, [{ type: 'text', text: url }]);
  const prefix = incomingMessage(message({ message_type: 101, content: url + '-longer', msg_elements: [card()] }).d, 'group');
  assert.equal(prefix.summary.mappedCards, 1);
});

test('quote and chat history never execute their nested old links or commands', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const quote = await f.mapper.dispatch(message({ message_type: 103, content: '#帮助', msg_elements: [card(), { content: '#危险指令' }], message_scene: { ext: ['ref_msg_idx=old-reference', 'auth_token=DO_NOT_EXPOSE'] } }));
  assert.equal(textOf(quote), '#帮助'); assert.equal(quote.source.ref_idx, 'old-reference');
  const history = await f.mapper.dispatch(message({ id: 'history', message_type: 102, content: url, msg_elements: [card()] }));
  assert.deepEqual(history.message, []); assert.equal(history.raw_message, '');
  const nested = await f.mapper.dispatch(message({ id: 'parallel-history', message_type: 101, msg_elements: [
    { message_type: 103, content: url, msg_elements: [card()] }, { message_type: 102, content: url }, { message_type: 0, content: '#帮助' }
  ] }));
  assert.equal(textOf(nested), '#帮助'); assert.equal(nested.qqbot.incoming.skippedHistory, 2);
  assert.equal(JSON.stringify([quote.qqbot, f.logger.records]).includes('DO_NOT_EXPOSE'), false);
});

test('malformed cards and unsafe jump URLs are ignored without mining labels or preview URLs', () => {
  const invalid = [undefined, null, 123, '', 'javascript:alert(1)', 'file:///tmp/video', 'qq://video', 'https://name:secret@example.test/', 'https://example.test/a b', 'https://example.test/\npath', 'x'.repeat(4097)];
  for (const value of invalid) {
    const result = incomingMessage(message(card(value === undefined ? null : value)).d, 'group');
    assert.deepEqual(result.parts, []); assert.equal(result.summary.ignoredCards, 1);
  }
  for (const ark_data of [null, [], 'unknown', { fields: null }, { fields: [] }, { fields: { preview: url, title: url }, prompt: url }]) {
    assert.deepEqual(incomingMessage(message({ message_type: 3, content: '#帮助', ark_data }).d, 'group').parts, []);
  }
});

test('nested messages from other authors, bots and cross-scope identities cannot become current content', () => {
  const d = message({ message_type: 101, author: { member_openid: 'current', id: 'same-author-id' }, msg_elements: [
    { ...card(), author: { member_openid: 'another' } }, { ...card(), author: { bot: true } },
    { ...card(), author: { user_openid: 'current' } }, { ...card(), author: { id: 'another-id' } },
    { ...card(), author: { member_openid: 'current' } }, { message_type: 0, content: '同一作者', author: { id: 'same-author-id' } }
  ] }).d;
  const result = incomingMessage(d, 'group');
  assert.equal(result.summary.skippedAuthors, 4); assert.deepEqual(result.parts, [{ type: 'text', text: url + '\n同一作者' }]);
});

test('nested text, depth, element and media budgets reject oversized or cyclic messages', () => {
  const cyclic = { message_type: 101 }; cyclic.msg_elements = [cyclic];
  const excessive = [
    { message_type: 101, msg_elements: Array.from({ length: 101 }, () => ({ content: 'x' })) },
    { message_type: 101, msg_elements: [cyclic] },
    { message_type: 101, content: 'x'.repeat(64000), msg_elements: [{ content: 'y' }] },
    { message_type: 101, content: 'x'.repeat(63999), msg_elements: [{ content: 'y' }] },
    { message_type: 101, content: 'x'.repeat(64000), msg_elements: [card()] },
    { message_type: 101, msg_elements: 'not-an-array' },
    { message_type: 101, msg_elements: [null] },
    { message_type: 101, msg_elements: [{ attachments: Array(6).fill({}) }, { attachments: Array(5).fill({}) }] },
    { message_type: 101, msg_elements: [{ content: 123 }] }
  ];
  for (const patch of excessive) assert.throws(() => incomingMessage(message(patch).d, 'group'), { code: 'EVENT_INVALID' });
  assert.equal(incomingMessage(message({ content: 'x'.repeat(64000) }).d, 'group').parts[0].text.length, 64000);
});

test('nested attachment validation retains the legacy HTTPS and unsupported-media behavior', () => {
  for (const url of ['http://example.test/image.png', 'https://name:secret@example.test/image.png', 'bad-url']) {
    assert.throws(() => incomingMessage(message({ message_type: 101, msg_elements: [{ attachments: [{ content_type: 'image/png', url }] }] }).d, 'group'), { code: 'EVENT_INVALID' });
  }
  const result = incomingMessage(message({ attachments: [{ content_type: 'unknown' }, null] }).d, 'group');
  assert.deepEqual(result.unsupportedAttachments, ['unsupported', 'unsupported']);
});

test('share diagnostics contain bounded counts and types without URLs, labels, identities or scene tokens', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  await f.mapper.dispatch(message({ ...card('https://b23.tv/private-video?token=SECRET'), message_scene: { ext: ['auth_token=SCENE_SECRET'] } }));
  assert.deepEqual(f.logger.records, ['[qqbot-adapter-plugin] incoming_card type=3 cards=1 mapped=1 ignored=0 history=0 authors=0']);
});

test('independent cards obey reception permissions and cross-event replay protection', async t => {
  const disabled = fixture(); t.after(() => disabled.registry.dispose());
  assert.equal(await disabled.mapper.dispatch(message(card())), false);
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose()); let count = 0;
  f.bot.on('message', () => count++); const p = message(card());
  await f.mapper.dispatch(p); await f.mapper.dispatch(p); await f.mapper.dispatch({ ...p, t: 'GROUP_AT_MESSAGE_CREATE' });
  assert.equal(count, 1);
});

test('top-level platform mentions retain their position before attachments after nested-message support', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(message({ content: '正文', mentions: [{ member_openid: 'another-member' }], attachments: [{ content_type: 'image/png', url: 'https://example.test/image.png' }] }));
  assert.deepEqual(e.message.map(part => part.type), ['text', 'at', 'image']);
  assert.equal(e.message[1].qq, 'qqbot:123456:group-user:another-member');
});

test('rejected-card diagnostics reveal link field types while hiding values and arbitrary keys', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  await f.mapper.dispatch(message({ message_type: 3, content: 'PRIVATE_CHAT_TEXT', ark_data: { prompt: 'PRIVATE_PROMPT', fields: { jump_url: null, url: 'https://example.test/PRIVATE_PATH?token=SECRET', title: 'PRIVATE_TITLE', PRIVATE_USER_KEY: 'PRIVATE_USER' }, PRIVATE_TOP_KEY: 'PRIVATE_VALUE' }, message_scene: { ext: ['auth_token=PRIVATE_SCENE'] } }));
  const line = f.logger.records.find(line => line.startsWith('[qqbot-adapter-plugin] incoming_card_schema '));
  assert.ok(line); assert.match(line, /"jump_url":"null"/); assert.match(line, /"url":"url:https"/);
  assert.equal(/PRIVATE|SECRET|example\.test/.test(line), false);
  assert.ok(line.length < 4096);
});

test('schema diagnostics cover encoded or array fields without executing or leaking their content', () => {
  for (const fields of [JSON.stringify({ jump_url: 'https://example.test/PRIVATE' }), [{ key: 'jump_url', value: 'https://example.test/PRIVATE' }]]) {
    const result = incomingMessage(message({ message_type: 3, ark_data: { fields } }).d, 'group');
    assert.deepEqual(result.parts, []);
    const shape = JSON.stringify(result.summary.ignoredCardSchemas);
    assert.ok(shape.includes('jump_url')); assert.equal(shape.includes('PRIVATE'), false);
  }
  const deep = { fields: {} }; deep.fields.data = deep;
  const result = incomingMessage(message({ message_type: 3, ark_data: deep }).d, 'group');
  assert.ok(JSON.stringify(result.summary.ignoredCardSchemas).length < 4096);
});
