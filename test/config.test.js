import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, validateConfig } from '../src/config.js';
import { createGuobaSupport } from '../guoba.support.js';

const secret = 'UNIT_TEST_SECRET_DO_NOT_USE';
async function storeFor(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  return new ConfigStore(path.join(root, 'private'));
}
const Result = { ok: (data, message) => ({ ok: true, data, message }), error: message => ({ ok: false, message }) };

test('defaults open no connection and private initialization persists no secret', async t => {
  const store = await storeFor(t);
  const data = await store.publicData();
  assert.equal(data.enabled, false); assert.equal(data.appSecret, ''); assert.equal(data.secretConfigured, false);
  await store.save({});
  assert.equal((await store.read()).appSecret, '');
});
test('write-only secret, blank preserves, whitespace preserves, all public data redacted', async t => {
  const store = await storeFor(t);
  const first = await store.save({ appId: '123', appSecret: secret, enabled: true });
  assert.equal(first.appSecret, ''); assert.equal(first.secretConfigured, true);
  await store.save({ appSecret: '' }); await store.save({ appSecret: '   ', receiveGroup: false });
  assert.equal((await store.read()).appSecret, secret);
  for (const value of [first, await store.publicData(), store]) assert.equal(JSON.stringify(value).includes(secret), false);
});
test('changing AppID requires fresh secret; failed save is atomic', async t => {
  const store = await storeFor(t);
  await store.save({ appId: '123', appSecret: secret });
  const original = await fs.readFile(store.filename, 'utf8');
  await assert.rejects(store.save({ appId: '456', appSecret: '' }), { code: 'SECRET_REQUIRED' });
  assert.equal(await fs.readFile(store.filename, 'utf8'), original);
  await store.save({ appId: '456', appSecret: 'ROTATED_FAKE_SECRET' });
  assert.equal((await store.publicData()).appId, '456');
});
test('concurrent configuration updates serialize without losing writes', async t => {
  const store = await storeFor(t);
  await Promise.all([store.save({ appId: '123', appSecret: secret }), store.save({ receiveGroup: false }), store.save({ masterC2COpenids: ['00123'] })]);
  const data = await store.publicData(); assert.equal(data.receiveGroup, false); assert.deepEqual(data.masterC2COpenids, ['00123']);
});
test('validate public fields, numeric OpenID remains string, reject unknown/prototype fields', async t => {
  assert.deepEqual(validateConfig({ masterC2COpenids: ['00123', '00123'] }).masterC2COpenids, ['00123']);
  for (const patch of [{ appId: 123 }, { enabled: 'true' }, { appSecret: secret }, { masterGroupOpenids: [123] }, { masterC2COpenids: ['a/b'] }, { maxReplies: 6 }, { replyWindowSeconds: 300 }, { receiveC2C: false, receiveGroup: false, enabled: true, appId: '123' }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateConfig(patch), { code: 'CONFIG_INVALID' });
  const store = await storeFor(t);
  await assert.rejects(store.save({ appId: '123', enabled: true }), { code: 'SECRET_REQUIRED' });
  await assert.rejects(store.save({ appSecret: `${secret}\n` }), { code: 'CONFIG_INVALID' });
});
test('POSIX config directory and file modes private', { skip: process.platform === 'win32' }, async t => {
  const store = await storeFor(t); await store.save({ appId: '123', appSecret: secret });
  assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(store.filename)).mode & 0o777, 0o600);
});
test('reject symlink/junction private directory', async t => {
  const store = await storeFor(t);
  const target = path.join(path.dirname(store.directory), 'target'); await fs.mkdir(target);
  await fs.symlink(target, store.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.save({}), { code: 'CONFIG_PRIVATE' });
  assert.deepEqual(await fs.readdir(target), []);
});
test('malformed config never echoes its content', async t => {
  const store = await storeFor(t); await store.save({});
  await fs.writeFile(store.filename, `{"${secret}`);
  await assert.rejects(store.publicData(), error => error.code === 'CONFIG_PRIVATE' && !String(error).includes(secret));
});
test('Guoba get/save/error responses never echo AppSecret or submitted data', async t => {
  const store = await storeFor(t); let reloads = 0;
  const support = createGuobaSupport({ store, reload: async () => { reloads++; } });
  const info = support.configInfo;
  let response = await info.setConfigData({ appId: '123', appSecret: secret, masterGroupOpenids: '00123\nother-openid', secretConfigured: false }, { Result });
  assert.equal(response.ok, true); assert.equal(reloads, 1);
  let data = await info.getConfigData(); assert.equal(data.appSecret, ''); assert.equal(data.secretConfigured, true); assert.equal(data.masterGroupOpenids, '00123\nother-openid');
  response = await info.setConfigData({ appSecret: '', enabled: true }, { Result }); assert.equal(response.ok, true);
  assert.equal((await store.read()).appSecret, secret);
  response = await info.setConfigData({ appId: secret, appSecret: secret }, { Result });
  assert.equal(response.ok, false);
  assert.equal(JSON.stringify([response, data, info.schemas]).includes(secret), false);
});
test('Guoba save reports reload failure without losing saved private configuration', async t => {
  const store = await storeFor(t);
  const info = createGuobaSupport({ store, reload: async () => { throw new Error(secret); } }).configInfo;
  const result = await info.setConfigData({ appId: '123', appSecret: secret }, { Result });
  assert.equal(result.ok, true); assert.match(result.message, /重新加载失败/); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await store.read()).appSecret, secret);
});
