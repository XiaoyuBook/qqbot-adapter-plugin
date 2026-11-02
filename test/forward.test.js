import test from 'node:test';
import assert from 'node:assert/strict';
import { makeForwardMsg } from '../src/forward.js';
import { fixture, payload, png } from './helpers.js';

test('legacy forward builder is local; helper title and text fit the final passive slot', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  for (let i = 0; i < 4; i++) await e.reply('previous');
  const forward = await e.group.makeForwardMsg([{ user_id: 88888, nickname: 'Bot', message: ['使用说明\n#uid', '：查看绑定账号'] }]);
  assert.equal(f.api.calls.length, 4);
  forward.data.meta.detail.news = [{ text: '绑定成功：使用命令说明' }];
  const result = await e.reply(forward);
  assert.equal(result.seq, 5); assert.deepEqual(result.warnings, ['forward_rendered_as_messages']);
  assert.equal(f.api.calls.length, 5); assert.equal(f.api.calls[4].body.msg_type, 0);
  assert.equal(f.api.calls[4].body.msg_id, 'trigger-id');
  assert.match(f.api.calls[4].body.content, /^绑定成功：使用命令说明\n使用说明\n#uid：查看绑定账号$/);
  assert.equal(e.qqbot.lastError, null);
});

test('forward text and images retain order, attribution and captions in both scopes', async () => {
  for (const scope of ['group', 'c2c']) {
    const f = fixture(), e = await f.mapper.dispatch(payload(scope));
    const contact = scope === 'group' ? e.group : e.friend;
    const forward = await contact.makeForwardMsg([
      { nickname: 'A', message: ['图一', [{ type: 'image', file: png }]] },
      { nickname: 'B', message: '后续文字' }
    ]);
    const result = await e.reply(forward);
    assert.ok(result.message_id);
    assert.deepEqual(f.api.calls.map(call => call.route.split('/').at(-1)), ['files', 'messages', 'messages']);
    assert.equal(f.api.calls[1].body.msg_type, 7); assert.match(f.api.calls[1].body.content, /1\. A\n图一$/);
    assert.equal(f.api.calls[2].body.msg_type, 0); assert.match(f.api.calls[2].body.content, /2\. B\n后续文字$/);
  }
});

test('forward and direct command buttons become native Markdown keyboards', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  const forward = await e.bot.makeForwardMsg({ message: ['用法', { type: 'button', data: [[{ text: '查看账号', callback: '#uid' }, { text: '输入查询', input: '#查询' }], [{ text: '#uid', callback: '#uid' }]] }] });
  const result = await e.reply(forward);
  assert.deepEqual(result.warnings, ['forward_rendered_as_messages', 'buttons_rendered_as_keyboard']);
  assert.equal(f.api.calls[0].body.msg_type, 2); assert.equal(f.api.calls[0].body.keyboard.content.rows[0].buttons[0].action.data, '#uid');
  assert.equal(f.api.calls[0].body.keyboard.content.rows[0].buttons[1].action.data, '#查询');
  assert.ok((await e.reply({ type: 'button', data: [[{ text: '#uid' }]] })).message_id);
  assert.equal(e.qqbot.lastError, null);
});

test('nested forwards are snapshots and other-user mentions and invalid images preflight without partial delivery', async () => {
  const f = fixture(), e = await f.mapper.dispatch(payload());
  const source = { message: 'original' };
  const nested = await makeForwardMsg(source); source.message = 'changed';
  const forward = await makeForwardMsg({ message: [nested, { type: 'at', qq: e.user_id }, 'tail'] });
  const result = await e.reply(forward);
  assert.ok(result.message_id); assert.match(f.api.calls[0].body.content, /original/); assert.doesNotMatch(f.api.calls[0].body.content, /changed/);
  const bad = await makeForwardMsg({ message: ['should not send', { type: 'at', qq: 'other' }] });
  assert.equal(await e.reply(bad), false); assert.equal(f.api.calls.length, 2); // Only the single safe feedback.
  assert.equal(f.api.calls.some(call => call.body.content?.includes('should not send')), false);
  const image = await makeForwardMsg({ message: ['also not sent', { type: 'image', file: Buffer.from('FAKE_SECRET_JSON') }] });
  assert.equal(await e.reply(image), false); assert.equal(f.api.calls.length, 2);
});

test('malformed, recursive, oversized and unsupported forwards fail with safe bounded errors', async () => {
  const cycle = []; cycle.push(cycle);
  let deep = 'text'; for (let i = 0; i < 10; i++) deep = [deep];
  for (const input of [[], {}, { message: cycle }, { message: { type: 'xml', file: 'FAKE_SECRET_PATH' } }, { message: { type: 'button', data: [{ text: 'test', callback: { secret: 'FAKE_SECRET' } }] } }]) {
    await assert.rejects(makeForwardMsg(input), error => error.code === 'FORWARD_INVALID' && !error.message.includes('FAKE_SECRET'));
  }
  const tooManyButtons = { type: 'button', data: Array.from({ length: 20 }, () => Array.from({ length: 60 }, () => ({ text: '' }))) };
  for (const input of [Array.from({ length: 101 }, () => ({ message: 'x' })), { message: 'x'.repeat(64001) }, { message: deep }, { message: Array.from({ length: 1001 }, () => []) }, { message: tooManyButtons }]) await assert.rejects(makeForwardMsg(input), { code: 'FORWARD_LIMIT' });
});

test('forward content still obeys reply ceiling, offline state and envelope authenticity', async () => {
  const f = fixture({ maxReplies: 1 }), e = await f.mapper.dispatch(payload());
  const forward = await e.group.makeForwardMsg({ message: 'x'.repeat(1501) });
  assert.equal(await e.reply(forward), false); assert.equal(e.qqbot.lastError.code, 'REPLY_LIMIT'); assert.equal(f.api.calls.length, 0);
  f.registry.setOnline(false); assert.equal(await e.reply(forward), false); assert.equal(e.qqbot.lastError.code, 'OFFLINE');
  f.registry.setOnline(true);
  assert.equal(await e.reply({ type: 'qqbot-forward', data: { meta: { detail: {} } } }), false); assert.equal(e.qqbot.lastError.code, 'UNSUPPORTED_MESSAGE');
});
