import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMedia, uploadMedia, uploadMarkdownImage } from '../src/media.js';
import { fixture, payload, png, config } from './helpers.js';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const silk = Buffer.from('\x02#!SILK_V3\ntest');
test('native record, video and generic file use their own file_type, name and passive message context', async () => {
  for (const scope of ['group', 'c2c']) {
    for (const [type, bytes, expected, name] of [['record', silk, 3, 'voice.silk'], ['video', mp4, 2, 'clip.mp4'], ['file', Buffer.from('plain document'), 4, 'notes.txt']]) {
      const f = fixture(), e = await f.mapper.dispatch(payload(scope));
      const result = await e.reply({ type, file: bytes, name });
      assert.ok(result.message_id); assert.equal(f.api.calls.length, 2);
      assert.equal(f.api.calls[0].body.file_type, expected); assert.equal(f.api.calls[0].body.file_name, name);
      assert.equal(f.api.calls[0].body.file_data, bytes.toString('base64')); assert.equal(f.api.calls[0].body.srv_send_msg, false);
      assert.equal(f.api.calls[1].body.msg_type, 7); assert.equal(f.api.calls[1].body.msg_id, 'trigger-id');
    }
  }
});

test('audio formats and URL media are accepted without local URL downloads; invalid types and sizes fail', async () => {
  for (const audio of [silk, Buffer.from('ID3test'), Buffer.from('RIFF1234WAVEdata'), Buffer.from('OggStest')]) assert.equal((await prepareMedia('record', audio, config())).fileType, 3);
  const remote = await prepareMedia('video', 'https://example.test/movie.mp4', config());
  const calls = [];
  await uploadMedia({ route: () => '/v2/groups/g/files', request: async (...args) => { calls.push(args); return { file_info: 'ok' }; } }, 'group', 'g', remote);
  assert.equal(calls[0][2].url, 'https://example.test/movie.mp4'); assert.equal(calls[0][2].file_type, 2);
  await assert.rejects(prepareMedia('record', Buffer.from('{"secret":"FAKE"}'), config()), { code: 'MEDIA_FORMAT' });
  await assert.rejects(prepareMedia('video', mp4, config({ maxMediaBytes: 1 })), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(prepareMedia('file', png, config(), '../bad'), { code: 'MEDIA_INVALID' });
});

test('large local files upload sequential bounded parts with whole and per-part hashes and final merge', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-native-media-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 7, 23), file = path.join(directory, 'large.bin'); await fs.writeFile(file, bytes);
  const prepared = await prepareMedia('file', file, config());
  const calls = [], uploaded = []; const blockSize = 2 * 1024 * 1024;
  const api = { route: (_scope, _target, resource) => `/v2/groups/g/${resource}`,
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (route.endsWith('upload_prepare')) return { upload_id: 'upload-test', block_size: String(blockSize), parts: Array.from({ length: Math.ceil(bytes.length / blockSize) }, (_, index) => ({ index, presigned_url: `https://unit.myqcloud.com/part-${index}`, block_size: String(Math.min(blockSize, bytes.length - index * blockSize)) })) };
      return route.endsWith('/files') ? { file_info: 'merged-file' } : {};
    }, async uploadPart(url, part) { uploaded.push({ url, bytes: Buffer.from(part) }); }
  };
  const result = await uploadMedia(api, 'group', 'g', prepared);
  assert.equal(result.file_info, 'merged-file'); assert.equal(uploaded.length, 7); assert.deepEqual(Buffer.concat(uploaded.map(item => item.bytes)), bytes);
  const start = calls[0].body;
  assert.equal(start.file_size, String(bytes.length)); assert.equal(start.md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(start.sha1, createHash('sha1').update(bytes).digest('hex')); assert.equal(start.md5_10m, createHash('md5').update(bytes.subarray(0, 10002432)).digest('hex'));
  for (const [index, call] of calls.filter(call => call.route.endsWith('upload_part_finish')).entries()) {
    assert.equal(call.body.part_index, index); assert.equal(call.body.md5, createHash('md5').update(uploaded[index].bytes).digest('hex'));
  }
  assert.deepEqual(calls.at(-1).body, { file_type: 4, srv_send_msg: false, file_name: 'large.bin', upload_id: 'upload-test' });
});

test('one-based video parts preserve the first bytes, tail and provider indices in group and c2c uploads', async () => {
  const blockSize = 2 * 1024 * 1024;
  const bytes = Buffer.concat([mp4, Buffer.alloc(5 * 1024 * 1024 + 7 - mp4.length, 23)]);
  bytes.fill(47, blockSize, blockSize * 2); bytes.fill(89, blockSize * 2);
  for (const scope of ['group', 'c2c']) {
    const prepared = await prepareMedia('video', bytes, config(), 'clip.mp4');
    const calls = [], uploaded = [];
    const api = {
      route: (actualScope, target, resource) => {
        assert.equal(actualScope, scope); assert.equal(target, 'target');
        return `/v2/${scope === 'group' ? 'groups' : 'users'}/target/${resource}`;
      },
      async request(method, route, body) {
        calls.push({ method, route, body });
        if (route.endsWith('/upload_prepare')) return {
          upload_id: 'one-based', block_size: String(blockSize),
          parts: [2, 0, 1].map(position => ({ index: position + 1, presigned_url: `https://unit.myqcloud.com/part-${position + 1}`, block_size: String(Math.min(blockSize, bytes.length - position * blockSize)) }))
        };
        return route.endsWith('/files') ? { file_info: 'complete' } : {};
      },
      async uploadPart(url, part) { uploaded.push({ url, bytes: Buffer.from(part) }); }
    };
    assert.equal((await uploadMedia(api, scope, 'target', prepared)).file_info, 'complete');
    assert.deepEqual(Buffer.concat(uploaded.map(part => part.bytes)), bytes);
    assert.deepEqual(uploaded.map(part => part.url), [1, 2, 3].map(index => `https://unit.myqcloud.com/part-${index}`));
    const finishes = calls.filter(call => call.route.endsWith('/upload_part_finish'));
    assert.deepEqual(finishes.map(call => call.body.part_index), [1, 2, 3]);
    for (const [position, call] of finishes.entries()) {
      assert.equal(call.body.block_size, String(uploaded[position].bytes.length));
      assert.equal(call.body.md5, createHash('md5').update(uploaded[position].bytes).digest('hex'));
    }
    assert.deepEqual(calls.at(-1).body, { file_type: 2, srv_send_msg: false, file_name: 'clip.mp4', upload_id: 'one-based' });
  }
});

test('invalid part sequences fail before sending bytes or completing an upload', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 7), blockSize = 2 * 1024 * 1024;
  for (const indices of [[-1, 0, 1], [2, 3, 4], [0, 1, 1], [1, 1, 2], [0, 2, 3], [1, 2, 4], [0, 1.5, 2], [1, '2', 3], [null, 1, 2]]) {
    let uploaded = 0, finished = 0, merged = 0, closed = false;
    const prepared = { fileType: 4, fileName: 'parts.bin', size: bytes.length, async open() {
      return { read: async (offset, length) => bytes.subarray(offset, offset + length), close: async () => { closed = true; } };
    } };
    const api = { route: (_scope, _target, resource) => resource,
      async request(_method, route) {
        if (route === 'upload_prepare') return { upload_id: 'invalid', block_size: String(blockSize), parts: indices.map((index, position) => ({ index, presigned_url: `https://unit.myqcloud.com/part-${position}`, block_size: String(Math.min(blockSize, bytes.length - position * blockSize)) })) };
        if (route === 'upload_part_finish') finished++;
        if (route === 'files') merged++;
        return {};
      },
      async uploadPart() { uploaded++; }
    };
    await assert.rejects(uploadMedia(api, 'group', 'g', prepared), { code: 'API_RESPONSE' });
    assert.equal(uploaded, 0); assert.equal(finished, 0); assert.equal(merged, 0); assert.equal(closed, true);
  }
});

test('file changes, private config, hardlinks, part failure and expired context never produce fake media success', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-native-private-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const file = path.join(directory, 'account.json'); await fs.writeFile(file, 'FAKE_SECRET');
  const prior = process.env.QQBOT_ADAPTER_PRIVATE_DIR; process.env.QQBOT_ADAPTER_PRIVATE_DIR = directory;
  try { await assert.rejects(prepareMedia('file', file, config()), { code: 'MEDIA_INVALID' }); }
  finally { if (prior === undefined) delete process.env.QQBOT_ADAPTER_PRIVATE_DIR; else process.env.QQBOT_ADAPTER_PRIVATE_DIR = prior; }
  const link = path.join(directory, 'hardlink.json'); await fs.link(file, link);
  await assert.rejects(prepareMedia('file', link, config()), { code: 'MEDIA_INVALID' }); await fs.unlink(link);
  const prepared = await prepareMedia('file', file, config()); await fs.writeFile(file, 'changed length');
  await assert.rejects(uploadMedia({}, 'group', 'g', prepared), { code: 'MEDIA_INVALID' });
  const big = await prepareMedia('file', Buffer.alloc(5 * 1024 * 1024), config()); let merges = 0;
  const api = { route: (_s, _t, resource) => resource, request: async (_m, route) => { if (route === 'files') merges++; return { upload_id: 'test', block_size: String(5 * 1024 * 1024), parts: [{ index: 0, presigned_url: 'https://unit.myqcloud.com/a' }] }; }, uploadPart: async () => { throw new Error('network failure'); } };
  await assert.rejects(uploadMedia(api, 'group', 'g', big)); assert.equal(merges, 0);
  await assert.rejects(uploadMedia(api, 'group', 'g', big, () => { throw new Error('expired context'); }));
});

test('Markdown images use matching MIME, hashes, ETag and return platform reference without persisting preview URLs', async () => {
  const prepared = await prepareMedia('image', png, config(), 'diagram.png'), calls = [];
  const hash = createHash('md5').update(png).digest('hex');
  const api = {
    async request(method, route, body) { calls.push({ method, route, body }); return route.endsWith('/prepare') ? { upload_id: 'asset-upload', presigned_url: 'https://unit.myqcloud.com/a' } : { image_id: 'asset', url: 'qqbot-media://image/v1/FAKE_TOKEN', ttl: 7776000, preview_url: 'https://unit.myqcloud.com/a?signature=FAKE' }; },
    async uploadPart(_url, data, mime) { assert.deepEqual(data, png); assert.equal(mime, 'image/png'); return { etag: hash }; }
  };
  const image = await uploadMarkdownImage(api, prepared);
  assert.deepEqual(image, { image_id: 'asset', url: 'qqbot-media://image/v1/FAKE_TOKEN', ttl: 7776000 });
  assert.equal(calls[0].body.content_type, 'image/png'); assert.equal(calls[0].body.file_size, png.length); assert.equal(calls[1].body.md5, hash);
});
