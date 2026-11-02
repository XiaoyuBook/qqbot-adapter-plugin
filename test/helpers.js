import { EventEmitter } from 'node:events';
import { validateConfig } from '../src/config.js';
import { AccountRegistry } from '../src/accounts.js';
import { EventMapper } from '../src/events.js';

export const config = patch => validateConfig({ appId: '123456', ...patch });
export const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
export const quietLogger = () => {
  const records = [];
  return { records, info: value => records.push(value), warn: value => records.push(value), error: value => records.push(value) };
};
export const fakeApi = () => {
  const calls = [];
  return {
    calls,
    token: async () => 'fake-token', gateway: async () => 'wss://api.sgroup.qq.com/websocket',
    invalidateToken() { this.invalidated = (this.invalidated || 0) + 1; }, close() { this.closed = true; },
    route: (scope, target, resource) => `/v2/${scope === 'group' ? 'groups' : 'users'}/${target}/${resource}`,
    async request(method, route, body) {
      calls.push({ method, route, body });
      return route.endsWith('/files') ? { file_info: 'fake-file-info', ttl: 60 } : { id: `sent-${calls.length}`, timestamp: 1 };
    }
  };
};
export function host() {
  const bot = new EventEmitter();
  bot.uin = 88888; bot[88888] = bot; bot.adapter = []; bot.isOnline = () => false;
  return bot;
}
export const payload = (scope = 'group', patch = {}) => ({
  op: 0, t: scope === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', s: 1,
  d: { id: 'trigger-id', timestamp: new Date().toISOString(), content: ' #测试', author: scope === 'group' ? { member_openid: '12345678901234567890123456789012' } : { user_openid: 'c2c-openid' }, ...(scope === 'group' ? { group_openid: 'group-openid' } : {}), ...patch }
});
export function fixture(patch = {}) {
  const cfg = config(patch), bot = host(), api = fakeApi(), logger = quietLogger();
  const registry = new AccountRegistry(bot, cfg); registry.register(); registry.setOnline(true);
  const mapper = new EventMapper({ registry, api, config: cfg, logger });
  return { cfg, bot, api, logger, registry, mapper };
}

export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
export class FakeTimers {
  constructor() { this.time = 100000; this.next = 1; this.jobs = new Map(); }
  setTimeout(fn, delay) { const id = this.next++; this.jobs.set(id, { at: this.time + delay, fn }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  async tick(ms) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.jobs.delete(next[0]); next[1].fn(); await settle();
    }
    this.time = end; await settle();
  }
}
export class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  terminate() { this.readyState = 3; this.terminated = true; this.emit('close', 1006, Buffer.from('ignored')); }
  closeCode(code) { this.readyState = 3; this.emit('close', code, Buffer.from('upstream-secret-chat')); }
}
