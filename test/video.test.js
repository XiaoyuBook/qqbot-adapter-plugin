import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePlayableVideo, runVideoTool, videoSoftLimit } from '../src/video.js';
import { prepareMedia, uploadMedia } from '../src/media.js';
import { validateConfig } from '../src/config.js';
import { AdapterError } from '../src/errors.js';

const probe = (duration = 90, overrides = {}) => JSON.stringify({ format: { duration: String(duration) }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p', duration: String(duration), ...overrides }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] });
function largeVideo() {
  const state = { closed: false, reads: 0 };
  return { state, prepared: { fileType: 2, fileName: 'original.mp4', size: videoSoftLimit + 1, async open() { return {
    async read(_offset, length) { state.reads++; return Buffer.alloc(length, 17); },
    async close() { state.closed = true; }
  }; } } };
}
async function absent(directory) { await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); }

for (const value of [{ fileType: 2, size: videoSoftLimit }, { fileType: 2, url: 'https://example.test/v.mp4' }, { fileType: 4, size: videoSoftLimit + 1 }, { fileType: 1, size: videoSoftLimit + 1 }]) {
  test('keep an existing media path without transcoding: ' + JSON.stringify(value), async () => {
    const result = await preparePlayableVideo(value, () => {}, () => assert.fail('unexpected conversion'));
    assert.equal(result.prepared, value); await result.cleanup();
  });
}

test('large video becomes a bounded video with a private snapshot and reusable reader; original is untouched', async () => {
  const { prepared, state } = largeVideo();
  let directory, encodes = 0;
  const run = async (tool, args, check) => {
    check();
    if (tool === 'ffprobe') {
      directory = path.dirname(args.at(-1));
      if (process.platform !== 'win32') assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
      return probe();
    }
    encodes++;
    assert.equal(tool, 'ffmpeg'); assert.ok(args.includes('libx264')); assert.ok(args.includes('+faststart'));
    assert.equal((await fs.stat(args[args.indexOf('-i') + 1])).size, prepared.size);
    await fs.writeFile(args.at(-1), Buffer.alloc(5000, 23));
    return '';
  };
  const result = await preparePlayableVideo(prepared, () => {}, run);
  try {
    assert.equal(encodes, 1); assert.equal(state.closed, true); assert.equal(result.prepared.fileType, 2);
    assert.equal(result.prepared.size, 5000); assert.equal(prepared.size, videoSoftLimit + 1);
    const reader = await result.prepared.open();
    try { assert.deepEqual(await reader.read(4090, 910), Buffer.alloc(910, 23)); }
    finally { await reader.close(); }
  } finally { await result.cleanup(); }
  await absent(directory);
});

test('a bitrate miss is retried without truncating duration; only a verified result is returned', async () => {
  const { prepared } = largeVideo(); let encodes = 0, directory; const rates = [];
  const result = await preparePlayableVideo(prepared, () => {}, async (tool, args) => {
    directory = path.dirname(args.at(-1));
    if (tool === 'ffprobe') return probe();
    rates.push(Number(args[args.indexOf('-b:v') + 1]));
    const handle = await fs.open(args.at(-1), 'w');
    try { await handle.truncate(++encodes === 1 ? videoSoftLimit + 1 : 5000); } finally { await handle.close(); }
    assert.equal(args.includes('-fs'), false);
    return '';
  });
  assert.equal(encodes, 2); assert.ok(rates[1] < rates[0]); assert.ok(result.prepared.size < videoSoftLimit);
  await result.cleanup(); await absent(directory);
});

for (const failure of ['encoder', 'missing-tools', 'bad-probe', 'truncated', 'wrong-codec', 'oversized', 'expired']) {
  test('failed conversion never returns original oversized video and removes temporary files: ' + failure, async () => {
    const { prepared, state } = largeVideo(); let directory, probes = 0, expired = false;
    const expected = failure === 'missing-tools' ? 'MEDIA_VIDEO_TOOLS' : failure === 'expired' ? 'REPLY_EXPIRED' : 'MEDIA_VIDEO_FAILED';
    await assert.rejects(preparePlayableVideo(prepared, () => { if (expired) throw new AdapterError('REPLY_EXPIRED'); }, async (tool, args, check) => {
      directory = path.dirname(args.at(-1));
      if (tool === 'ffprobe') {
        if (failure === 'missing-tools') throw new AdapterError('MEDIA_VIDEO_TOOLS');
        if (failure === 'bad-probe') return '{}';
        return probe(++probes > 1 && failure === 'truncated' ? 2 : 90, failure === 'wrong-codec' && probes > 1 ? { codec_name: 'hevc' } : {});
      }
      if (failure === 'encoder') throw new AdapterError('MEDIA_VIDEO_FAILED');
      if (failure === 'expired') { expired = true; check(); }
      const output = await fs.open(args.at(-1), 'w');
      try { await output.truncate(failure === 'oversized' ? videoSoftLimit + 1 : 5000); } finally { await output.close(); }
      return '';
    }), { code: expected });
    assert.equal(state.closed, true); await absent(directory);
  });
}

test('incomplete input is rejected and its reader is closed', async () => {
  let closed = false, ran = false;
  const prepared = { fileType: 2, fileName: 'bad.mp4', size: videoSoftLimit + 1, open: async () => ({ read: async () => Buffer.alloc(1), close: async () => { closed = true; } }) };
  await assert.rejects(preparePlayableVideo(prepared, () => {}, () => { ran = true; }), { code: 'MEDIA_INVALID' });
  assert.equal(closed, true); assert.equal(ran, false);
});

test('subprocess errors are sanitized and expired reply kills a running encoder', async () => {
  await assert.rejects(runVideoTool('qqbot-nonexistent-encoder-unit-test', [], () => {}), { code: 'MEDIA_VIDEO_TOOLS' });
  await assert.rejects(runVideoTool(process.execPath, ['-e', 'console.error("PRIVATE_SOURCE");process.exit(1)'], () => {}), error => error.code === 'MEDIA_VIDEO_FAILED' && !error.message.includes('PRIVATE_SOURCE'));
  await assert.rejects(runVideoTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], () => { throw new AdapterError('REPLY_EXPIRED'); }), { code: 'REPLY_EXPIRED' });
});

const haveTools = ['ffmpeg', 'ffprobe'].every(tool => spawnSync(tool, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0);
test('real FFmpeg: oversized MP4 retains duration and uploads as video in group and c2c, including cleanup after API failure', { skip: !haveTools }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-video-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const input = path.join(directory, 'original.mp4');
  await runVideoTool('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', input], () => {});
  // A valid trailing ISO BMFF free box crosses the size boundary without a
  // long, CPU-heavy fixture encode. The real encoder must preserve all frames.
  const padding = Buffer.alloc(videoSoftLimit); padding.writeUInt32BE(padding.length); padding.write('free', 4);
  await fs.appendFile(input, padding);
  const original = await fs.stat(input), before = new Set(await fs.readdir(os.tmpdir()));
  for (const scope of ['group', 'c2c']) {
    const prepared = await prepareMedia('video', input, validateConfig({})); let uploaded;
    const api = { route: (actualScope, _target, resource) => { assert.equal(actualScope, scope); return resource; }, request: async (_method, resource, body) => {
      assert.equal(resource, 'files'); assert.equal(body.file_type, 2); assert.equal(body.srv_send_msg, false);
      uploaded = Buffer.from(body.file_data, 'base64'); assert.ok(uploaded.length < videoSoftLimit);
      if (scope === 'c2c') throw new AdapterError('API_NETWORK');
      return { file_info: 'video-reference' };
    } };
    if (scope === 'c2c') await assert.rejects(uploadMedia(api, scope, 'target', prepared), { code: 'API_NETWORK' });
    else assert.equal((await uploadMedia(api, scope, 'target', prepared)).file_info, 'video-reference');
    const output = path.join(directory, scope + '.mp4'); await fs.writeFile(output, uploaded);
    const actual = JSON.parse(await runVideoTool('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], () => {}));
    assert.ok(Math.abs(Number(actual.format.duration) - 3) < 0.1);
    assert.equal(actual.streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
    assert.equal(actual.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  }
  assert.equal((await fs.stat(input)).size, original.size);
  assert.equal((await fs.stat(input)).mtimeMs, original.mtimeMs);
  assert.deepEqual((await fs.readdir(os.tmpdir())).filter(name => name.startsWith('qqbot-video-') && !before.has(name)), []);
});
