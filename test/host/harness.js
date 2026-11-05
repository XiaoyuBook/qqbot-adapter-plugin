import vm from 'node:vm';
import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import { pipeline } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import lodash from 'lodash';
import moment from 'moment';
import { Client, segment } from 'icqq';
import { quietLogger, fakeApi, config } from '../helpers.js';
import { AccountRegistry } from '../../src/accounts.js';
import { EventMapper } from '../../src/events.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
export async function source(name, file) {
  const filename = path.join(root, '.verification-cache/fixtures', name, file);
  let value;
  try { value = await fs.readFile(filename); }
  catch { throw new Error('缺少已校验的宿主源码，请先运行 npm run fixtures。'); }
  if (createHash('sha256').update(value).digest('hex') !== manifest[name].files[file]) throw new Error(`宿主源码 SHA256 不匹配：${name}/${file}`);
  return value.toString('utf8');
}

export async function harness(t, { cfgPatch = {}, adapterConfig = {}, userFactory, timers = globalThis } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qqbot-host-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const bot = new Client({ log_level: 'off', data_dir: temp });
  bot.uin = 88888; bot[88888] = bot; bot.adapter = [];
  const logger = quietLogger(); logger.mark = logger.info; logger.debug = () => {}; logger.red = String;
  const redis = { incr: () => {}, expire: () => {}, set: () => {} };
  const groupCfg = { onlyReplyAt: 1, botAlias: ['机器人'], groupGlobalCD: 0, singleCD: 0 };
  const other = { disableGuildMsg: false, blackQQ: [], whiteQQ: [], blackGroup: [], whiteGroup: [] };
  const cfg = { bot: { sendmsg_error: false, serial_load: false, skip_login: true }, masterQQ: [10001], getGroup: () => groupCfg, getOther: () => other, ...cfgPatch };
  const userIds = [];
  const noteUser = { async create(e) { userIds.push(e.user_id); return userFactory ? userFactory(e) : undefined; } };
  const handler = { has: () => false, call: () => {}, callAll: () => {}, add: () => {} };
  const context = vm.createContext({ Bot: bot, logger, redis, Buffer, segment, process: { platform: process.platform, cwd: process.cwd.bind(process) }, console, setTimeout: timers.setTimeout.bind(timers), clearTimeout: timers.clearTimeout.bind(timers), setInterval, clearInterval });
  context.global = context;
  const modules = new Map();
  function synthetic(id, exports) {
    if (!modules.has(id)) modules.set(id, new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context, identifier: id }));
    return modules.get(id);
  }
  const dependencies = {
    'node:util': { default: util }, util: { promisify: util.promisify }, stream: { pipeline },
    'node-fetch': { default: async () => { throw new Error('No real fetch allowed in the host harness'); } },
    'node:fs/promises': { default: fs }, 'node:fs': { default: nodeFs }, 'node:path': { default: path },
    lodash: { default: lodash }, moment: { default: moment }, icqq: { segment, Client },
    'node-schedule': { default: { scheduleJob() { throw new Error('No schedules allowed in host harness'); } } },
    chokidar: { default: { watch() { throw new Error('No filesystem watchers allowed in host harness'); } } },
    '#miao': { Common: {}, Version: { version: 'test' } }
  };
  async function get(file) {
    const id = `miao/${file}`;
    if (modules.has(id)) return modules.get(id);
    const module = new vm.SourceTextModule(await source('miao', file), { context, identifier: id });
    modules.set(id, module);
    await module.link(async (specifier, parent) => {
      if (dependencies[specifier]) return synthetic(specifier, dependencies[specifier]);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier.slice(5)), specifier));
      if (manifest.miao.files[resolved]) return get(resolved);
      if (/config\/config.js$/.test(resolved)) return synthetic('cfg', { default: cfg });
      if (/config\/init.js$/.test(resolved)) return synthetic('cfg-init', {});
      if (/handler.js$/.test(resolved)) return synthetic('handler', { default: handler });
      if (/NoteUser.js$/.test(resolved)) return synthetic('noteUser', { default: noteUser });
      if (/renderer\/loader.js$/.test(resolved)) return synthetic('renderer-loader', { default: { getRenderer: () => ({ render: async () => { throw new Error('No browser renderer allowed in the host harness'); } }) } });
      if (/mysInfo.js$/.test(resolved)) return synthetic('mysInfo', { default: { initCache: async () => {} } });
      return synthetic(resolved, { default: {} });
    });
    return module;
  }
  const loaderModule = await get('lib/plugins/loader.js'); await loaderModule.evaluate();
  const loader = loaderModule.namespace.default; loader.pluginCount = 0;
  const Plugin = (await get('lib/plugins/plugin.js')).namespace.default;
  const runtimeClass = (await get('lib/plugins/runtime.js')).namespace.default;
  const eventModule = await get('lib/events/message.js'); await eventModule.evaluate();
  const listener = new eventModule.namespace.default();
  const pending = [];
  const deal = loader.deal.bind(loader);
  loader.deal = event => { const promise = deal(event); pending.push(promise); return promise; };
  bot.on('message', event => listener.execute(event));
  for (const type of ['notice', 'request']) {
    const module = await get(`lib/events/${type}.js`); await module.evaluate();
    const listener = new module.namespace.default(); bot.on(type, event => listener.execute(event));
  }
  const registry = new AccountRegistry(bot, config(adapterConfig), { segment, logger, timers }); registry.register(); registry.setOnline(true); t.after(() => registry.dispose());
  const api = fakeApi(); const mapper = new EventMapper({ registry, api, config: config(adapterConfig), logger });
  async function flush() { await Promise.all(pending.splice(0)); }

  async function napcat() {
    const nccommon = { isTRSS: () => false, getMessage: async message => ({ message: message.map(item => ({ type: 'text', text: item.data.text })), raw_message: '#测试', ToString: '#测试' }), info: () => {}, debug: () => {}, error: () => {} };
    class NCWebsocket { async get_version_info() { return { app_name: 'fake-napcat', app_version: 'test' }; } }
    const ncModule = new vm.SourceTextModule(await source('napcat', 'adapter/index.js'), { context, identifier: 'napcat/adapter/index.js' });
    await ncModule.link(specifier => {
      if (specifier === 'node-napcat-ts') return synthetic('nc-ws', { NCWebsocket });
      if (specifier === '../lib/index.js') return synthetic('nc-common', { nccommon, cfg: () => ({}) });
      if (specifier === 'path') return synthetic('path', { default: path });
      if (specifier === 'fs') return synthetic('fs', { default: nodeFs });
      throw new Error(`Unknown NapCat import: ${specifier}`);
    });
    await ncModule.evaluate();
    const nc = new ncModule.namespace.default({}); nc.bot = { uin: 10001, nickname: 'Fake NapCat' }; nc.isTRSS = false; nc.protobuf = { default: {} };
    nc.LoadAll = async () => { nc.isLoadingComple = true; };
    nc.sendMsg = async () => ({ message_id: 'napcat-sent' });
    await nc.BotInit(); return nc;
  }
  return { bot, logger, cfg, groupCfg, other, loader, Plugin, runtimeClass, userIds, registry, api, mapper, flush, napcat, hostModule: get };
}
