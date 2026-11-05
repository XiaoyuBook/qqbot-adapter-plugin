import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { imageSize } from 'image-size';
import { AdapterError } from './errors.js';
import { preparePlayableVideo } from './video.js';

const directLimit = 4 * 1024 * 1024;
const hardLimit = 200 * 1024 * 1024;
function fileResult(value) { if (typeof value?.file_info !== 'string' || !value.file_info || value.file_info.length > 65536) throw new AdapterError('API_RESPONSE'); return value; }
export function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.href.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.hostname === 'localhost' || isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error();
    return url.href;
  } catch { throw new AdapterError('MEDIA_INVALID'); }
}
function filename(value, fallback) {
  const name = value || fallback;
  if (typeof name !== 'string' || !name || name.length > 255 || /[\\/\r\n\0]/.test(name) || name === '.' || name === '..') throw new AdapterError('MEDIA_INVALID');
  return name;
}
function format(bytes, kind) {
  const text = bytes.toString('latin1');
  if (kind === 'file') return 'bin';
  if (kind === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (/^GIF8[79]a/.test(text)) return 'gif';
    if (/^RIFF[\s\S]{4}WEBP/.test(text)) return 'webp';
    if (text.startsWith('BM')) return 'bmp';
  }
  if (kind === 'video' && bytes.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  if (kind === 'record') {
    if (/^\x02?#!SILK_V3/.test(text)) return 'silk';
    if (text.startsWith('ID3') || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'mp3';
    if (/^RIFF[\s\S]{4}WAVE/.test(text)) return 'wav';
    if (text.startsWith('OggS')) return 'ogg';
  }
  throw new AdapterError(kind === 'image' ? 'IMAGE_INVALID' : 'MEDIA_FORMAT');
}
async function localHandle(value, maxBytes) {
  let handle;
  try {
    const resolved = await fs.realpath(value);
    const roots = [fileURLToPath(new URL('../private/', import.meta.url)), process.env.QQBOT_ADAPTER_PRIVATE_DIR].filter(Boolean);
    if (roots.some(root => { const relative = path.relative(path.resolve(root), resolved); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); })) throw new Error();
    const before = await fs.lstat(value);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error();
    handle = await fs.open(value, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== before.size || stat.ino !== before.ino || stat.size < 1) throw new Error();
    if (stat.size > maxBytes) throw new AdapterError('MEDIA_TOO_LARGE');
    return { handle, stat };
  } catch (error) { await handle?.close(); throw error instanceof AdapterError ? error : new AdapterError('MEDIA_INVALID'); }
}

export async function prepareMedia(kind, value, config, name) {
  const fileType = { image: 1, video: 2, record: 3, file: 4 }[kind];
  if (!fileType) throw new AdapterError('MEDIA_INVALID');
  const maxBytes = Math.min(hardLimit, kind === 'image' ? config.maxImageBytes : config.maxMediaBytes ?? hardLimit);
  if (typeof value === 'string' && /^https?:/i.test(value)) return { fileType, url: mediaUrl(value), fileName: name ? filename(name) : undefined };
  let data, local;
  if (Buffer.isBuffer(value)) data = value;
  else if (value instanceof Uint8Array) data = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (typeof value === 'string' && value.startsWith('base64://')) {
    const encoded = value.slice(9);
    if (encoded.length > Math.ceil(maxBytes / 3) * 4) throw new AdapterError('MEDIA_TOO_LARGE');
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdapterError('MEDIA_INVALID');
    data = Buffer.from(encoded, 'base64');
  } else if (typeof value === 'string' && value && !value.includes('\0')) {
    try { local = value.startsWith('file:') ? fileURLToPath(value) : value; }
    catch { throw new AdapterError('MEDIA_INVALID'); }
  }
  else throw new AdapterError('MEDIA_INVALID');
  let stat, head;
  if (local) {
    const opened = await localHandle(local, maxBytes);
    try { stat = opened.stat; head = Buffer.alloc(Math.min(stat.size, 32)); await opened.handle.read(head, 0, head.length, 0); }
    finally { await opened.handle.close(); }
  } else {
    if (!data.length) throw new AdapterError('MEDIA_INVALID');
    if (data.length > maxBytes) throw new AdapterError('MEDIA_TOO_LARGE');
    head = data.subarray(0, 32);
  }
  const extension = format(head, kind), size = stat?.size ?? data.length;
  const fileName = filename(name, local ? path.basename(local) : `${kind}.${extension}`);
  return { fileType, fileName, size, extension, async open() {
    if (data) return { read: async (offset, length) => data.subarray(offset, offset + length), close: async () => {} };
    const opened = await localHandle(local, maxBytes);
    if (opened.stat.ino !== stat.ino || opened.stat.size !== stat.size || opened.stat.mtimeMs !== stat.mtimeMs) { await opened.handle.close(); throw new AdapterError('MEDIA_INVALID'); }
    return { async read(offset, length) { const buffer = Buffer.alloc(length); const result = await opened.handle.read(buffer, 0, length, offset); if (result.bytesRead !== length) throw new AdapterError('MEDIA_INVALID'); return buffer; }, close: () => opened.handle.close() };
  } };
}

export async function markdownImageDimensions(prepared) {
  // Unknown URL dimensions use native media instead of guessing a Markdown box.
  if (prepared.url || prepared.fileType !== 1 || prepared.size > 10 * 1024 * 1024) return undefined;
  const reader = await prepared.open();
  let bytes;
  try { bytes = await reader.read(0, prepared.size); }
  finally { await reader.close(); }
  try {
    // Give the parser an exact backing store, including for pooled Buffer slices.
    let { width, height, orientation } = imageSize(Uint8Array.from(bytes));
    if (orientation >= 5 && orientation <= 8) [width, height] = [height, width];
    if ([width, height].every(value => Number.isSafeInteger(value) && value > 0)) return { width, height };
  } catch { /* A readable image without usable dimensions can still use native media. */ }
  return undefined;
}

export async function uploadMedia(api, scope, target, prepared, check = () => {}) {
  check();
  const video = await preparePlayableVideo(prepared, check);
  try { return await uploadPreparedMedia(api, scope, target, video.prepared, check); }
  finally { await video.cleanup(); }
}

async function uploadPreparedMedia(api, scope, target, prepared, check) {
  check();
  const route = resource => api.route(scope, target, resource);
  if (prepared.url) return fileResult(await api.request('POST', route('files'), { file_type: prepared.fileType, srv_send_msg: false, url: prepared.url, ...(prepared.fileName ? { file_name: prepared.fileName } : {}) }));
  const reader = await prepared.open();
  try {
    if (prepared.size <= directLimit) {
      const bytes = await reader.read(0, prepared.size); check();
      return fileResult(await api.request('POST', route('files'), { file_type: prepared.fileType, srv_send_msg: false, file_name: prepared.fileName, file_data: bytes.toString('base64') }));
    }
    const md5 = createHash('md5'), sha1 = createHash('sha1'), md5_10m = createHash('md5');
    for (let offset = 0; offset < prepared.size; offset += 1024 * 1024) {
      const bytes = await reader.read(offset, Math.min(1024 * 1024, prepared.size - offset));
      md5.update(bytes); sha1.update(bytes);
      if (offset < 10002432) md5_10m.update(bytes.subarray(0, Math.min(bytes.length, 10002432 - offset)));
    }
    check();
    const upload = await api.request('POST', route('upload_prepare'), { file_type: prepared.fileType, file_size: String(prepared.size), file_name: prepared.fileName, md5: md5.digest('hex'), sha1: sha1.digest('hex'), md5_10m: md5_10m.digest('hex') });
    const blockSize = Number(upload.block_size);
    if (typeof upload.upload_id !== 'string' || !upload.upload_id || upload.upload_id.length > 2048 || !Number.isInteger(blockSize) || blockSize < 1 || blockSize > hardLimit || !Array.isArray(upload.parts) || (upload.parts.length && upload.parts.length !== Math.ceil(prepared.size / blockSize)) || upload.parts.length > 1000) throw new AdapterError('API_RESPONSE');
    if (upload.parts.some(part => !part || !Number.isInteger(part.index))) throw new AdapterError('API_RESPONSE');
    const parts = [...upload.parts].sort((a, b) => a.index - b.index);
    // Provider responses use either zero-based or one-based part numbers. Byte
    // offsets follow position; completion must retain the provider's number.
    const firstIndex = parts[0]?.index ?? 0;
    if (![0, 1].includes(firstIndex)) throw new AdapterError('API_RESPONSE');
    for (const [position, part] of parts.entries()) {
      const size = Math.min(blockSize, prepared.size - position * blockSize);
      if (part.index !== position + firstIndex || typeof part.presigned_url !== 'string' || (part.block_size !== undefined && Number(part.block_size) !== size)) throw new AdapterError('API_RESPONSE');
    }
    for (const [position, part] of parts.entries()) {
      check();
      const size = Math.min(blockSize, prepared.size - position * blockSize);
      const bytes = await reader.read(position * blockSize, size);
      await api.uploadPart(part.presigned_url, bytes); check();
      await api.request('POST', route('upload_part_finish'), { upload_id: upload.upload_id, part_index: part.index, block_size: String(size), md5: createHash('md5').update(bytes).digest('hex') });
    }
    check();
    return fileResult(await api.request('POST', route('files'), { file_type: prepared.fileType, srv_send_msg: false, file_name: prepared.fileName, upload_id: upload.upload_id }));
  } finally { await reader.close(); }
}

export async function uploadMarkdownImage(api, prepared, beforeComplete = async () => {}) {
  if (prepared.url || prepared.size > 10 * 1024 * 1024 || !['png', 'jpg', 'gif', 'webp'].includes(prepared.extension)) throw new AdapterError('MEDIA_INVALID');
  const reader = await prepared.open();
  try {
    const bytes = await reader.read(0, prepared.size), md5 = createHash('md5').update(bytes).digest('hex');
    const contentType = `image/${prepared.extension === 'jpg' ? 'jpeg' : prepared.extension}`;
    const fileName = path.basename(prepared.fileName, path.extname(prepared.fileName)) + `.${prepared.extension}`;
    const upload = await api.request('POST', '/v2/media-images/prepare', { file_name: fileName, file_size: prepared.size, content_type: contentType, md5, sha1: createHash('sha1').update(bytes).digest('hex') });
    if (typeof upload.upload_id !== 'string' || !upload.upload_id || typeof upload.presigned_url !== 'string') throw new AdapterError('API_RESPONSE');
    const result = await api.uploadPart(upload.presigned_url, bytes, contentType);
    if (result?.etag && result.etag.toLowerCase() !== md5) throw new AdapterError('API_RESPONSE');
    await beforeComplete();
    const image = await api.request('POST', '/v2/media-images/complete', { upload_id: upload.upload_id, md5 });
    if (typeof image.image_id !== 'string' || typeof image.url !== 'string' || !image.url.startsWith('qqbot-media://image/v1/')) throw new AdapterError('API_RESPONSE');
    return { image_id: image.image_id, url: image.url, ttl: image.ttl };
  } finally { await reader.close(); }
}
