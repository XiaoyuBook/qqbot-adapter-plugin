import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialApi, endpoints, apiRouteAllowed } from '../src/api.js';
import { config } from './helpers.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
test('current official routes support empty 200/204 deletions, management and interaction ACK', async () => {
  const calls = [];
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', fetchImpl: async (url, init) => {
    if (url === endpoints.token) return json({ access_token: 'FAKE_TOKEN', expires_in: 7200 });
    calls.push({ url, init }); return new Response(null, { status: calls.length % 2 ? 200 : 204 });
  } });
  await api.request('DELETE', '/v2/groups/group/messages/ROBOT1.0_abc%2Fdef%3D');
  await api.request('DELETE', '/v2/users/user/messages/ROBOT1.0_c2c');
  await api.request('PUT', '/interactions/test-interaction', { code: 0 });
  await api.request('POST', '/v2/groups/group/restrict_chat_setting', { members: [] });
  await api.request('DELETE', '/v2/media-images/102083127_test/delete');
  assert.equal(calls.length, 5); assert.ok(calls.every(call => call.url.startsWith('https://api.bot.qq.com/')));
  assert.equal(calls[4].url, 'https://api.bot.qq.com/v2/media-images/102083127_test/delete');
  assert.ok(calls.every(call => call.init.headers.Authorization === 'QQBot FAKE_TOKEN'));
  api.close();
});

test('route guard enforces method, path, query keys and traversal bounds before auth', () => {
  for (const [method, route] of [
    ['GET', '/v2/groups/g/members?cursor=a%2Fb%3F%3D'], ['POST', '/v2/groups/g/upload_prepare'],
    ['POST', '/v2/users/u/upload_part_finish'], ['GET', '/v2/groups/g/members/m'],
    ['POST', '/v2/groups/g/approval_join_request/m'], ['POST', '/v2/media-images/prepare'],
    ['GET', '/v2/media-images?cursor=next'], ['DELETE', '/v2/media-images/102083127_test/delete']
  ]) assert.equal(apiRouteAllowed(method, route), true, route);
  for (const [method, route] of [
    ['POST', '/gateway'], ['GET', '/v2/groups/g/messages'], ['DELETE', '/v2/groups/g/messages/..'],
    ['DELETE', '/v2/groups/g/messages/%2e%2e'], ['DELETE', '/v2/groups/g/messages/%0a'],
    ['GET', '/v2/groups/g/members?secret=FAKE'], ['GET', '/v2/groups/g/members?cursor=x?y'],
    ['POST', '/v2/groups/g/files?cursor=x'], ['PUT', '//evil.example/'], ['POST', '/v2/groups/g/unknown'],
    ['DELETE', '/v2/media-images/102083127_test']
  ]) assert.equal(apiRouteAllowed(method, route), false, route);
});

test('platform permission failures are explicit and never retried or expose response bodies', async () => {
  for (const code of [11253, 11282, 304037, 40062003]) {
    let sends = 0;
    const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', fetchImpl: async url => {
      if (url === endpoints.token) return json({ access_token: 'FAKE_TOKEN', expires_in: 7200 });
      sends++; return json({ err_code: code, message: 'FAKE_PRIVATE_DETAILS' }, 403);
    } });
    await assert.rejects(api.request('DELETE', '/v2/groups/g/messages/id'), error => error.code === 'PERMISSION_REQUIRED' && error.platformCode === code && !String(error).includes('FAKE_PRIVATE_DETAILS'));
    assert.equal(sends, 1); api.close();
  }
});

test('COS upload sends bytes and MIME only, rejects redirects and unapproved hosts, never carries bot credentials', async () => {
  const calls = [];
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(null, { status: 200, headers: { etag: '"abc123"' } });
  } });
  const bytes = Buffer.from('test bytes');
  const result = await api.uploadPart('https://unit.cos.ap-guangzhou.myqcloud.com/upload?signature=FAKE_SIGNATURE', bytes, 'image/png');
  assert.equal(result.etag, 'abc123'); assert.equal(calls[0].init.body, bytes);
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'image/png' }); assert.equal(calls[0].init.redirect, 'error');
  for (const url of ['http://unit.myqcloud.com/a', 'https://127.0.0.1/a', 'https://myqcloud.com.evil.test/a', 'https://user:pass@unit.myqcloud.com/a']) await assert.rejects(api.uploadPart(url, bytes), { code: 'MEDIA_INVALID' });
  assert.equal(calls.length, 1); api.close();
});

test('a large presigned upload can finish after the JSON request timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const api = new OfficialApi({ config: config({ requestTimeoutMs: 15000 }), appSecret: 'FAKE_SECRET', fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      setTimeout(() => resolve(new Response(null, { status: 200 })), 20000);
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  } });
  t.after(() => api.close());
  const pending = api.uploadPart('https://unit.myqcloud.com/upload', Buffer.alloc(10 * 1024 * 1024));
  t.mock.timers.tick(15001); assert.equal(signal.aborted, false);
  t.mock.timers.tick(4999); await pending;
  assert.equal(signal.aborted, false);
});

test('presigned upload deadlines remain bounded, honor longer configuration and keep small uploads unchanged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [requestTimeoutMs, size, deadline] of [[15000, 10 * 1024 * 1024, 60000], [90000, 10 * 1024 * 1024, 90000], [15000, 1024, 15000]]) {
    let signal;
    const api = new OfficialApi({ config: config({ requestTimeoutMs }), appSecret: 'FAKE_SECRET', fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    } });
    const pending = assert.rejects(api.uploadPart('https://unit.myqcloud.com/upload', Buffer.alloc(size)), { code: 'API_NETWORK' });
    t.mock.timers.tick(deadline - 1); assert.equal(signal.aborted, false);
    t.mock.timers.tick(1); await pending; assert.equal(signal.aborted, true);
    api.close();
  }
});

test('closing the API still aborts a large media upload immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const api = new OfficialApi({ config: config(), appSecret: 'FAKE_SECRET', fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  } });
  const pending = assert.rejects(api.uploadPart('https://unit.myqcloud.com/upload', Buffer.alloc(10 * 1024 * 1024)), { code: 'API_NETWORK' });
  api.close(); await pending; assert.equal(signal.aborted, true);
});
