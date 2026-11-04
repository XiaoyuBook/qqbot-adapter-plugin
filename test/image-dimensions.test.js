import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareMedia, markdownImageDimensions } from '../src/media.js';
import { fixture, payload, png, config } from './helpers.js';

// Blank, locally generated images; no user screenshots or external assets.
const image = name => fileURLToPath(new URL(`./fixtures/images/${name}`, import.meta.url));

test('real PNG, GIF, JPEG and WebP dimensions include tall charts and JPEG display orientation', async () => {
  for (const [name, expected] of [
    ['tall.png', { width: 640, height: 2560 }], ['tiny.gif', { width: 3, height: 7 }],
    ['rotated.jpg', { width: 10, height: 20 }], ['tiny.webp', { width: 5, height: 9 }]
  ]) {
    const prepared = await prepareMedia('image', image(name), config());
    assert.deepEqual(await markdownImageDimensions(prepared), expected, name);
  }
});

test('file, buffer and base64 chart replies send one mention-first message with actual dimensions', async t => {
  const f = fixture({ mentionBeforeImage: true }); t.after(() => f.registry.dispose());
  const file = image('tall.png'), bytes = await fs.readFile(file);
  const e = await f.mapper.dispatch(payload());
  for (const input of [file, bytes, `base64://${bytes.toString('base64')}`]) {
    const result = await e.reply({ type: 'image', file: input }); assert.ok(result.message_id);
  }
  const sent = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(sent.length, 3);
  for (const [i, message] of sent.entries()) {
    assert.equal(message.body.msg_type, 2); assert.equal(message.body.msg_seq, i + 1);
    assert.match(message.body.markdown.content, /^<qqbot-at-user[^\n]+\n!\[图片 #640px #2560px\]\(qqbot-media:\/\/image\/v1\//);
    assert.equal(message.body.markdown.force_verify_image_resource, true);
  }
});

test('unreadable dimensions fall back to one native image instead of sending placeholder Markdown', async t => {
  const f = fixture({ mentionBeforeImage: true }); t.after(() => f.registry.dispose());
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16);
  const truncated = png.subarray(0, 16);
  const e = await f.mapper.dispatch(payload());
  for (const bytes of [zero, truncated]) {
    assert.equal(await markdownImageDimensions(await prepareMedia('image', bytes, config())), undefined);
    const result = await e.reply(bytes);
    assert.ok(result.message_id); assert.ok(result.warnings.includes('image_mention_layout_unavailable'));
  }
  const sent = f.api.calls.filter(call => call.route.endsWith('/messages'));
  assert.equal(sent.length, 2); assert.ok(sent.every(call => call.body.msg_type === 7 && !call.body.markdown));
  assert.equal(f.api.calls.some(call => call.route.startsWith('/v2/media-images')), false);
});

test('dimension probing closes its reader and propagates file access errors without a second upload', async () => {
  let closed = false;
  const prepared = { fileType: 1, size: png.length, open: async () => ({
    read: async () => { throw new Error('read failed'); }, close: async () => { closed = true; }
  }) };
  await assert.rejects(markdownImageDimensions(prepared), /read failed/); assert.equal(closed, true);
  assert.equal(await markdownImageDimensions({ url: 'https://example.test/a.png' }), undefined);
});
