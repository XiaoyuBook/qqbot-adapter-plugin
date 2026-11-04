import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, payload, png } from './helpers.js';
import { AdapterError } from '../src/errors.js';

test('detailed zero-delivery receipts distinguish validation, rejection, ambiguous POST and upload failure', async t => {
  for (const [stage, error, status, delivery] of [
    ['message', new AdapterError('PERMISSION_REQUIRED', { status: 403, platformCode: 11253 }), 'rejected', 'rejected'],
    ['message', new AdapterError('API_NETWORK'), 'unknown', 'unknown'],
    ['message', new AdapterError('API_RESPONSE'), 'unknown', 'unknown'],
    ['message', new AdapterError('API_REJECTED', { status: 502 }), 'unknown', 'unknown'],
    ['upload', new AdapterError('API_NETWORK'), 'rejected', 'not_sent']
  ]) {
    const f = fixture(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
    let calls = 0; f.api.request = async () => { calls++; throw error; };
    const r = await e.reply(stage === 'upload' ? { type: 'image', file: png } : 'text', false, { receipt: true });
    assert.equal(r.ok, false); assert.equal(r.status, status); assert.equal(r.failure.delivery, delivery); assert.equal(r.failure.stage, stage);
    assert.deepEqual(r.message_ids, []); assert.equal(r.message_id, undefined); assert.equal(calls, 1);
    assert.equal(e.qqbot.lastReceipt, r);
  }
  const f = fixture(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
  const r = await e.reply('text', false, { receipt: true, invalid: true });
  assert.equal(r.status, 'rejected'); assert.equal(r.failure.stage, 'validation'); assert.equal(r.failure.delivery, 'not_sent');
  assert.equal(r.failure.code, 'UNSUPPORTED_OPTIONS'); assert.deepEqual(r.message_ids, []);
});

test('legacy failures remain false but expose immutable receipts; partial success retains IDs even without opt-in', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
  const request = f.api.request.bind(f.api); let posts = 0;
  f.api.request = async (...args) => { if (++posts === 2) throw new Error('FAKE_SECRET PRIVATE_CHAT'); return request(...args); };
  const partial = await e.reply('a'.repeat(1501));
  assert.equal(partial.status, 'partial'); assert.deepEqual(partial.message_ids, ['sent-1']); assert.equal(partial.failure.delivery, 'unknown');
  assert.throws(() => partial.message_ids.push('forged'), TypeError);
  assert.equal(JSON.stringify(partial).includes('FAKE_SECRET'), false);
  f.api.request = async () => { throw new AdapterError('API_NETWORK'); };
  assert.equal(await e.reply('legacy failure'), false); assert.equal(e.qqbot.lastReceipt.status, 'unknown');
  assert.equal(partial.completed_parts, 1); assert.equal(posts, 2);
});

test('warnings belong to one send call and do not leak from an earlier fallback', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); const e = await f.mapper.dispatch(payload());
  const first = await e.reply('quote', true); assert.ok(first.warnings.includes('quote_display_unavailable'));
  const second = await e.reply('plain'); assert.equal(second.warnings, undefined); assert.equal(first.warnings.length, 1);
});

test('a later native or mention-first image upload failure retains earlier text IDs without claiming image delivery', async t => {
  for (const mentionBeforeImage of [false, true]) {
    const f = fixture({ mentionBeforeImage }); t.after(() => f.registry.dispose());
    const e = await f.mapper.dispatch(payload()); const request = f.api.request.bind(f.api);
    let posts = 0;
    f.api.request = async (method, route, body) => {
      if (route.endsWith('/files') || route.endsWith('/prepare')) throw new AdapterError('API_NETWORK');
      if (route.endsWith('/messages')) posts++;
      return request(method, route, body);
    };
    const r = await e.reply(['a'.repeat(1501), { type: 'image', file: png }]);
    assert.equal(r.status, 'partial'); assert.equal(r.failure.stage, 'upload'); assert.equal(r.failure.delivery, 'not_sent');
    assert.deepEqual(r.message_ids, ['sent-1']); assert.equal(posts, 1); assert.equal(r.total_parts, 2);
  }
});
