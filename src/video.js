import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AdapterError } from './errors.js';

// Use decimal MB conservatively. QQ downgrades videos above its soft limit to
// files; never upload an oversized local video and call that playable success.
export const videoSoftLimit = 30_000_000;
const outputLimit = 28_000_000;
let converting = false;

export function runVideoTool(tool, args, check) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
    const chunks = [];
    let size = 0, failure;
    const cancel = error => { failure ??= error; child.kill('SIGKILL'); };
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 65536) cancel(new AdapterError('MEDIA_VIDEO_FAILED'));
      else chunks.push(bytes);
    });
    child.on('error', error => { failure ??= new AdapterError(error.code === 'ENOENT' ? 'MEDIA_VIDEO_TOOLS' : 'MEDIA_VIDEO_FAILED'); });
    const timer = setInterval(() => { try { check(); } catch (error) { cancel(error); } }, 250);
    timer.unref();
    child.on('close', code => {
      clearInterval(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new AdapterError('MEDIA_VIDEO_FAILED'));
      else { try { check(); resolve(Buffer.concat(chunks).toString('utf8')); } catch (error) { reject(error); } }
    });
  });
}

function probeArgs(file) {
  // FFmpeg only receives a private local snapshot, never an arbitrary URL or
  // caller-supplied arguments. External data references remain disabled.
  return ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,pix_fmt,duration:stream_disposition=attached_pic', '-of', 'json', file];
}
function videoInfo(text) {
  try {
    const info = JSON.parse(text);
    const video = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = info.streams?.find(stream => stream.codec_type === 'audio');
    const duration = Number(info.format?.duration), videoDuration = Number(video?.duration ?? duration);
    if (!video || !Number.isInteger(video.index) || video.index < 0 || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(videoDuration) || videoDuration <= 0 || ![video.width, video.height].every(value => Number.isInteger(value) && value >= 2 && value <= 16384)) throw new Error();
    return { video, audio, duration, videoDuration };
  } catch { throw new AdapterError('MEDIA_VIDEO_FAILED'); }
}

export async function preparePlayableVideo(prepared, check = () => {}, run = runVideoTool) {
  if (prepared.fileType !== 2 || prepared.url || prepared.size <= videoSoftLimit) return { prepared, cleanup: async () => {} };
  const deadline = Date.now() + 120000;
  const alive = () => { check(); if (Date.now() >= deadline) throw new AdapterError('MEDIA_VIDEO_TIMEOUT'); };
  // Bound CPU use across all accounts. Queued jobs retain their reply deadline.
  while (converting) { alive(); await delay(250); }
  alive(); converting = true;
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-video-'));
    await fs.chmod(directory, 0o700);
    const input = path.join(directory, 'input.mp4'), output = path.join(directory, 'video.mp4');
    const reader = await prepared.open();
    try {
      const writer = await fs.open(input, 'wx', 0o600);
      try {
        for (let offset = 0; offset < prepared.size; offset += 1024 * 1024) {
          alive();
          const length = Math.min(1024 * 1024, prepared.size - offset), bytes = await reader.read(offset, length);
          if (bytes.length !== length) throw new AdapterError('MEDIA_INVALID');
          await writer.writeFile(bytes);
        }
      } finally { await writer.close(); }
    } finally { await reader.close(); }
    const source = videoInfo(await run('ffprobe', probeArgs(input), alive));
    const audioRate = source.audio ? 96000 : 0;
    const initialRate = Math.min(8_000_000, Math.floor(outputLimit * 0.88 * 8 / source.duration - audioRate));
    if (initialRate < 64000) throw new AdapterError('MEDIA_VIDEO_FAILED');
    for (let attempt = 0; attempt < 2; attempt++) {
      alive();
      const bitrate = Math.floor(initialRate * (attempt ? 0.7 : 1));
      const filter = "scale=w='min(iw,if(gte(iw,ih),1280,720))':h='min(ih,if(gte(iw,ih),720,1280))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-threads', '2', '-i', input, '-filter_threads', '2', '-map', '0:' + source.video.index, '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1', '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p', '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2), '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', output];
      await run('ffmpeg', args, alive);
      const stat = await fs.stat(output);
      if (!stat.isFile() || stat.size <= 0) throw new AdapterError('MEDIA_VIDEO_FAILED');
      if (stat.size > outputLimit) continue;
      const result = videoInfo(await run('ffprobe', probeArgs(output), alive));
      if (result.video.codec_name !== 'h264' || result.video.pix_fmt !== 'yuv420p' || (source.audio && result.audio?.codec_name !== 'aac') || Math.abs(result.videoDuration - source.videoDuration) > Math.max(1, source.videoDuration * 0.01)) throw new AdapterError('MEDIA_VIDEO_FAILED');
      await fs.chmod(output, 0o600);
      const owner = directory;
      directory = undefined;
      return { prepared: { fileType: 2, fileName: path.parse(prepared.fileName).name.slice(0, 251) + '.mp4', extension: 'mp4', size: stat.size, async open() {
        const handle = await fs.open(output, 'r');
        return { async read(offset, length) { const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, offset); if (result.bytesRead !== length) throw new AdapterError('MEDIA_INVALID'); return buffer; }, close: () => handle.close() };
      } }, cleanup: () => fs.rm(owner, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }) };
    }
    throw new AdapterError('MEDIA_VIDEO_FAILED');
  } finally {
    converting = false;
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
