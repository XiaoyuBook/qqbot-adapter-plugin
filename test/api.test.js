import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialApi, endpoints } from '../src/api.js';
import { config } from './helpers.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
test('token request, headers, RAM cache and singleflight refresh', async () => {
  let now = 0; const calls = [];
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json(url === endpoints.token ? { access_token: `token-${calls.length}`, expires_in: '100' } : { url: 'wss://api.sgroup.qq.com/websocket' });
  } });
  const tokens = await Promise.all([api.token(), api.token(), api.token()]); assert.equal(calls.length, 1); assert.equal(new Set(tokens).size, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: '123456', clientSecret: 'FAKE_SECRET' });
  await api.gateway(); assert.equal(calls[1].url, `${endpoints.production}/gateway`); assert.equal(calls[1].options.headers.Authorization, 'QQBot token-1'); assert.equal(calls[1].options.redirect, 'error');
  now = 81000; await api.token(); assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(api).includes('FAKE_SECRET'), false); assert.equal(JSON.stringify(api).includes('token-1'), false); api.close();
});
test('sandbox API base and one definite 401 token refresh, stable payload', async () => {
  let tokens = 0, sends = 0; const bodies = [];
  const api = new OfficialApi({ config: config({ sandbox: true }), appSecret: 'FAKE', fetchImpl: async (url, init) => {
    if (url === endpoints.token) return json({ access_token: `token-${++tokens}`, expires_in: 7200 });
    assert.match(url, /^https:\/\/sandbox\.api\.sgroup\.qq\.com/); bodies.push(init.body);
    return ++sends === 1 ? json({ code: 11244, message: 'SECRET_IN_UPSTREAM_BODY' }, 401) : json({ id: 'reply-id' });
  } });
  await api.request('POST', '/v2/groups/group-openid/messages', { msg_id: 'trigger', msg_seq: 1 });
  assert.equal(tokens, 2); assert.equal(sends, 2); assert.equal(bodies[0], bodies[1]); api.close();
});
test('no retry for network failure, 429 or 500 POST; sanitize platform content', async () => {
  for (const failure of [null, 429, 500]) {
    let sends = 0;
    const api = new OfficialApi({ config: config(), appSecret: 'SECRET', fetchImpl: async url => {
      if (url === endpoints.token) return json({ access_token: 'TOKEN', expires_in: 7200 });
      sends++; if (!failure) throw new Error('SECRET TOKEN PRIVATE_CHAT');
      return json({ code: 22009, message: 'SECRET TOKEN PRIVATE_CHAT' }, failure, { 'retry-after': '2' });
    } });
    await assert.rejects(api.request('POST', '/v2/users/openid/messages', {}), error => {
      assert.equal(JSON.stringify(error).includes('PRIVATE_CHAT'), false); assert.equal(String(error).includes('SECRET'), false);
      if (failure) { assert.equal(error.platformCode, 22009); assert.equal(error.retryAfterMs, 2000); }
      return true;
    }); assert.equal(sends, 1); api.close();
  }
});
test('reject malformed token and 200 business error without dumping response', async () => {
  for (const body of [{ message: 'FAKE_SECRET' }, { access_token: 'token', expires_in: 0 }, { code: 123, access_token: 'token', message: 'FAKE_SECRET' }]) {
    const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', fetchImpl: async () => json(body) });
    await assert.rejects(api.token(), error => error.code === 'AUTH_FAILED' && !String(error).includes('FAKE_SECRET')); api.close();
  }
});
test('close aborts in-flight HTTP body read and prevents new requests', async () => {
  let observedSignal;
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE', fetchImpl: async (_url, init) => {
    observedSignal = init.signal;
    return { ok: true, status: 200, headers: new Headers(), text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('FAKE_SECRET')))) };
  } });
  const pending = api.token(); await Promise.resolve(); api.close();
  await assert.rejects(pending, { code: 'API_NETWORK' }); assert.equal(observedSignal.aborted, true);
  await assert.rejects(api.token(), { code: 'OFFLINE' });
});
test('only owned API routes accepted; responses bounded', async () => {
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE', fetchImpl: async () => json({ access_token: 't', expires_in: 7200 }) });
  for (const route of ['https://evil.example', '//evil', '/v2/users/../../messages', '/v2/groups/g/messages?secret=foo']) await assert.rejects(api.request('GET', route), { code: 'API_RESPONSE' });
  api.close();
  const huge = new OfficialApi({ config: config(), appSecret: 'FAKE', fetchImpl: async () => new Response('x'.repeat(1048577)) });
  await assert.rejects(huge.token(), { code: 'API_RESPONSE' }); huge.close();
});
