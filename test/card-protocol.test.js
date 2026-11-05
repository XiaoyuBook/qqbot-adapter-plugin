import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload } from './helpers.js';

const ark = { ark_type: 'miniapp', ark_name: '分享卡片', prompt: '分享', fields: { preview: 'https://example.test/cover.png', source: '来源', title: '标题', provider_destination: 'https://b23.tv/example' } };
const incoming = patch => ({ ...payload('group', { content: '', message_type: 3, ark_data: ark, ...patch }), t: 'GROUP_MESSAGE_CREATE' });

test('incoming cards use the standard JSON element contract and preserve provider extension fields', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(incoming({ message_scene: { ext: ['auth_token=PRIVATE_SCENE'] } }));
  assert.equal(e.message.length, 1); assert.equal(e.message[0].type, 'json');
  assert.equal(typeof e.message[0].data, 'string'); assert.deepEqual(JSON.parse(e.message[0].data), ark);
  assert.equal(e.raw_message, e.message[0].data); assert.equal(e.atBot, false);
  assert.equal(JSON.stringify(e.message).includes('PRIVATE_SCENE'), false);
  assert.equal(f.api.calls.length, 0);
});

test('card transport is provider-neutral and never requires a recognized video or jump field', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  for (const [i, card] of [
    { ark_type: 'map', fields: { address: '位置' } },
    { app: 'example.share', meta: { arbitrary: { custom: 'https://example.test/article' } } },
    { ark_type: 'future', fields: { title: '未知类型卡片', custom_flag: true } }
  ].entries()) {
    const e = await f.mapper.dispatch(incoming({ id: 'provider-' + i, ark_data: card }));
    assert.equal(e.message[0]?.type, 'json'); assert.deepEqual(JSON.parse(e.message[0].data), card);
  }
});

test('card payload fields cannot change outer message identity or permissions', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const e = await f.mapper.dispatch(incoming({ ark_data: { ...ark, author: { member_openid: 'someone-else', member_role: 'owner' }, isMaster: true } }));
  assert.equal(e.message[0]?.type, 'json'); assert.equal(e.isMaster, false); assert.equal(e.sender.role, 'member');
  assert.equal(e.user_id, 'qqbot:123456:group-user:12345678901234567890123456789012');
});
