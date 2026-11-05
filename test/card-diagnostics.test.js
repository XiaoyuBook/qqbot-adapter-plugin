import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cardDiagnostics } from '../src/card-diagnostics.js';
import { incomingMessage } from '../src/incoming.js';
import { fixture, payload } from './helpers.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);

test('diagnostics distinguish body links, escaped links and encoded links without exposing their values', () => {
  const result = cardDiagnostics({ fields: { preview: 'https://media.example.test/private.png?token=SECRET', url: String.raw`https:\/\/target.example.test\/private?key=SECRET`, extra: 'https%3A%2F%2Fencoded.example.test%2Fprivate' } }, 'https://body.example.test/PRIVATE');
  assert.deepEqual(result.body.hosts, [hash('body.example.test')]);
  assert.equal(result.body.httpUrls, 1);
  const url = result.nodes.find(node => node.at === '$.fields.url');
  assert.equal(url.httpUrls, 1); assert.deepEqual(url.hosts, [hash('target.example.test')]);
  assert.equal(result.nodes.find(node => node.at === '$.fields.extra').encodedHttp, true);
  assert.equal(/SECRET|PRIVATE|example\.test|private/.test(JSON.stringify(result)), false);
});

test('unknown keys, credentials and identity values are absent from card logs while delivery is unchanged', async t => {
  const f = fixture({ receiveGroupMessages: true }); t.after(() => f.registry.dispose());
  const secret = 'DO_NOT_LOG_THIS_VALUE';
  const ark = { ark_name: secret, prompt: secret, fields: { [secret]: secret, source: secret, url: 'https://username:password@private.example.test/path?secret=' + secret }, author: { member_openid: secret } };
  const event = await f.mapper.dispatch({ ...payload('group', { message_type: 3, content: secret, ark_data: ark, message_scene: { ext: ['auth_token=' + secret] } }), t: 'GROUP_MESSAGE_CREATE' });
  assert.deepEqual(event.message, [{ type: 'json', data: JSON.stringify(ark) }]);
  assert.equal(event.raw_message, JSON.stringify(ark));
  const logs = JSON.stringify(f.logger.records);
  assert.equal(/DO_NOT_LOG|username|password|private\.example|member_openid|group-openid|123456789/.test(logs), false);
  assert.equal(f.api.calls.length, 0);
  assert.ok(logs.includes('incoming_card_details'));
});

test('diagnostic schemas have node, depth and per-message bounds', () => {
  const broad = cardDiagnostics({ fields: Object.fromEntries(Array.from({ length: 128 }, (_, i) => ['extension' + i, i])) });
  assert.equal(broad.nodes.length, 32); assert.equal(broad.truncated, true);
  const deep = cardDiagnostics({ data: { data: { data: { data: { url: 'https://example.test' } } } } });
  assert.equal(deep.truncated, true); assert.equal(deep.nodes.length, 5);
  const card = { message_type: 3, content: '', ark_data: { fields: { title: 'private' } } };
  const result = incomingMessage(payload('group', { message_type: 101, content: '', msg_elements: Array(10).fill(card) }).d, 'group');
  assert.equal(result.summary.cards, 10); assert.equal(result.summary.cardSchemas.length, 2);
  assert.equal(result.parts.length, 1);
});

test('nulls, arrays, missing body and scalar values expose only their types and sizes', () => {
  const result = cardDiagnostics({ fields: [null, true, 42, []] });
  assert.deepEqual(result.body, { type: 'undefined' });
  assert.deepEqual(result.nodes.map(node => node.type), ['object', 'array', 'null', 'boolean', 'number', 'array']);
  assert.equal(result.truncated, false);
});
