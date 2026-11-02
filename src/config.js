import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AdapterError } from './errors.js';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export const defaults = Object.freeze(JSON.parse(await fs.readFile(new URL('../config/default.json', import.meta.url), 'utf8')));
const booleans = ['enabled', 'sandbox', 'receiveGroup', 'receiveC2C', 'receiveGroupMessages', 'receiveGroupNotices', 'allowProactive'];
const lists = ['masterGroupOpenids', 'masterC2COpenids', 'allowedGroupOpenids', 'allowedC2COpenids'];
const ranges = { replyWindowSeconds: [1, 300], c2cReplyWindowSeconds: [1, 3600], maxReplies: [1, 5], maxImageBytes: [1, 209715200], maxMediaBytes: [1, 209715200], requestTimeoutMs: [1000, 120000], reconnectMinMs: [1000, 60000], reconnectMaxMs: [1000, 300000] };
export const validOpenid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError('CONFIG_INVALID');
  if (Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new AdapterError('CONFIG_INVALID');
  const cfg = { ...structuredClone(defaults), ...value };
  for (const key of booleans) if (typeof cfg[key] !== 'boolean') throw new AdapterError('CONFIG_INVALID');
  if (typeof cfg.appId !== 'string' || (cfg.appId !== '' && !/^\d{1,32}$/.test(cfg.appId))) throw new AdapterError('CONFIG_INVALID');
  for (const key of lists) {
    if (!Array.isArray(cfg[key]) || cfg[key].length > 1000 || !cfg[key].every(validOpenid)) throw new AdapterError('CONFIG_INVALID');
    cfg[key] = [...new Set(cfg[key])];
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) throw new AdapterError('CONFIG_INVALID');
  }
  if (cfg.reconnectMaxMs < cfg.reconnectMinMs || (cfg.enabled && (!cfg.appId || (!cfg.receiveGroup && !cfg.receiveC2C)))) throw new AdapterError('CONFIG_INVALID');
  return cfg;
}

async function inspectPrivate(filename, directory = false) {
  const stat = await fs.lstat(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) throw new AdapterError('CONFIG_PRIVATE');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new AdapterError('CONFIG_PRIVATE');
    await fs.chmod(filename, directory ? 0o700 : 0o600);
  }
}

async function readPrivate(filename) {
  try {
    await inspectPrivate(filename);
    const content = await fs.readFile(filename, 'utf8');
    if (content.length > 262144) throw new AdapterError('CONFIG_INVALID');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof AdapterError) throw error;
    throw new AdapterError('CONFIG_PRIVATE');
  }
}

async function atomicWrite(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
    await inspectPrivate(filename);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export class ConfigStore {
  #queue = Promise.resolve();
  constructor(directory = process.env.QQBOT_ADAPTER_PRIVATE_DIR || path.join(pluginRoot, 'private')) {
    this.directory = path.resolve(directory);
    const relative = path.relative(pluginRoot, this.directory);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) && relative !== 'private' && !relative.startsWith(`private${path.sep}`))) throw new AdapterError('CONFIG_PRIVATE');
    this.filename = path.join(this.directory, 'account.json');
  }

  async #prepare() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await inspectPrivate(this.directory, true);
    } catch { throw new AdapterError('CONFIG_PRIVATE'); }
  }

  async read() {
    await this.#queue;
    return this.#read();
  }

  async #read() {
    await this.#prepare();
    const document = await readPrivate(this.filename);
    if (!document) return { config: validateConfig({}), appSecret: '' };
    if (document.version !== 1 || typeof document.appSecret !== 'string' || document.appSecret.length > 4096 || /[\r\n\0]/.test(document.appSecret)) throw new AdapterError('CONFIG_INVALID');
    const config = validateConfig(document.config);
    if (config.enabled && !document.appSecret) throw new AdapterError('SECRET_REQUIRED');
    return { config, appSecret: document.appSecret };
  }

  async publicData() {
    const { config, appSecret } = await this.read();
    return { ...config, appSecret: '', secretConfigured: Boolean(appSecret) };
  }

  save(patch) {
    const operation = this.#queue.then(async () => {
      const previous = await this.#read();
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AdapterError('CONFIG_INVALID');
      const configPatch = {};
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'appSecret' || key === 'secretConfigured') continue;
        if (!Object.hasOwn(defaults, key)) throw new AdapterError('CONFIG_INVALID');
        configPatch[key] = value;
      }
      const config = validateConfig({ ...previous.config, ...configPatch });
      const input = patch.appSecret;
      if (input !== undefined && (typeof input !== 'string' || input.length > 4096 || /[\r\n\0]/.test(input))) throw new AdapterError('CONFIG_INVALID');
      const appSecret = input?.trim() || previous.appSecret;
      if ((config.appId !== previous.config.appId && previous.appSecret && !input?.trim()) || (config.enabled && !appSecret)) throw new AdapterError('SECRET_REQUIRED');
      try { await atomicWrite(this.filename, { version: 1, config, appSecret }); }
      catch (error) { if (error instanceof AdapterError) throw error; throw new AdapterError('CONFIG_PRIVATE'); }
      return { ...config, appSecret: '', secretConfigured: Boolean(appSecret) };
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
