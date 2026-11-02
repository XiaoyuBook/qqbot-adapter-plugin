import { accountId, identity } from './identity.js';
import { AdapterError, unsupported, logFailure, safeError } from './errors.js';
import { makeForwardMsg } from './forward.js';
import { validOpenid } from './config.js';
import { eventContext } from './context.js';
import { GroupOperations, boundedString } from './group.js';
import { PassiveReply } from './reply.js';
import { richSegment } from './rich.js';
import { prepareMedia, uploadMedia, uploadMarkdownImage } from './media.js';
import { acquireSegmentBridge } from './segment.js';
import { setTimeout as delay } from 'node:timers/promises';

const owners = new WeakMap();
const unsupportedMethods = ['getAvatarUrl', 'getChatHistory', 'recallMsg', 'getMemberMap', 'getMemberList', 'muteMember', 'muteAll', 'kickMember', 'setCard', 'setName', 'setAdmin', 'pokeMember', 'sendFile', 'uploadFile', 'thumbUp', 'getSimpleInfo', 'getFileUrl', 'mute', 'kick', 'poke', 'quit', 'setTitle', 'renew'];

export function contact(info, sendMsg = () => { throw new AdapterError('PASSIVE_ONLY'); }, rejectUnsupported = unsupported) {
  const result = { ...info, info: { ...info }, sendMsg, makeForwardMsg };
  for (const name of unsupportedMethods) result[name] = rejectUnsupported;
  return result;
}

export class AccountRegistry {
  constructor(host, config, { now = Date.now, logger = globalThis.logger, timers = globalThis, segment = globalThis.segment, sleep } = {}) {
    if (!host || typeof host.emit !== 'function' || Array.isArray(host.uin)) throw new AdapterError('HOST_UNSUPPORTED');
    this.host = host;
    this.config = config;
    this.id = accountId(config.appId);
    this.online = false;
    Object.assign(this, { now, logger, timers });
    this.abort = new AbortController();
    this.sleep = sleep ?? (ms => delay(ms, undefined, { signal: this.abort.signal }));
    this.messages = new Map(); this.timerHandles = new Set(); this.recalls = new Map();
    this.releaseSegment = acquireSegmentBridge(this, segment);
    this.account = {
      uin: this.id, self_id: this.id, appId: config.appId,
      nickname: 'QQ 官方机器人', adapter: 'QQBot',
      version: { id: 'qqbot-adapter-plugin', version: '0.2.0' },
      fl: new Map(), gl: new Map(), gml: new Map(),
      isOnline: () => this.online,
      pickFriend: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickUser: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickGroup: id => this.#pick(id, 'group', this.account.gl),
      getFriendList: unsupported, getGroupList: unsupported,
      sendPrivateMsg: () => { throw new AdapterError('PASSIVE_ONLY'); },
      sendGroupMsg: () => { throw new AdapterError('PASSIVE_ONLY'); },
      makeForwardMsg, segment: richSegment,
      uploadMarkdownImage: async (file, name) => { this.checkOnline(); return uploadMarkdownImage(this.api, await prepareMedia('image', file, { ...this.config, maxImageBytes: Math.min(this.config.maxImageBytes, 10 * 1024 * 1024) }, name)); },
      getMarkdownImages: async (cursor = '') => { this.checkOnline(); boundedString(cursor, 2048, true); return this.api.request('GET', `/v2/media-images${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`); },
      deleteMarkdownImage: async id => { this.checkOnline(); boundedString(id, 256); await this.api.request('DELETE', `/v2/media-images/${encodeURIComponent(id)}/delete`); return true; },
      deleteMsg: id => this.deleteMsg(id), getMsg: unsupported,
      getGroupInfo: id => this.group(this.openid(id, 'group')).getInfo(),
      getGroupMemberInfo: (groupId, userId) => this.group(this.openid(groupId, 'group')).getMemberInfo(userId)
    };
    this.account.sendPrivateMsg = (id, ...args) => this.send('c2c', this.openid(id, 'c2c-user'), ...args);
    this.account.sendGroupMsg = (id, ...args) => this.send('group', this.openid(id, 'group'), ...args);
  }
  bindApi(api) { this.api = api; }
  checkOnline() { if (!this.online || !this.api) throw new AdapterError('OFFLINE'); }
  checkTarget(scope, target) {
    if (!validOpenid(target)) throw new AdapterError('OPERATION_INVALID');
    const allowed = scope === 'group' ? this.config.allowedGroupOpenids : this.config.allowedC2COpenids;
    if (allowed.length && !allowed.includes(target)) throw new AdapterError('TARGET_DENIED');
  }
  openid(id, kind) {
    const prefix = `${this.id}:${kind}:`;
    if (typeof id !== 'string' || !id.startsWith(prefix) || !validOpenid(id.slice(prefix.length))) throw new AdapterError('OPERATION_INVALID');
    return id.slice(prefix.length);
  }
  group(target) { return new GroupOperations(this, target); }
  context(scope, target) { const current = eventContext.getStore(); return current?.registry === this && current.scope === scope && current.target === target ? current : null; }
  send(scope, target, ...args) {
    this.checkTarget(scope, target);
    const current = this.context(scope, target);
    if (current) return current.reply.send(...args);
    if (!this.config.allowProactive) throw new AdapterError('PASSIVE_ONLY');
    if (!(scope === 'group' ? this.account.gl : this.account.fl).has(identity(this.config.appId, scope === 'group' ? 'group' : 'c2c-user', target))) throw new AdapterError('MESSAGE_UNKNOWN');
    this.checkOnline();
    return new PassiveReply({ registry: this, api: this.api, config: this.config, scope, target, proactive: true, online: () => this.online, logger: this.logger, now: this.now }).send(...args);
  }
  messageKey(scope, target, id) { return JSON.stringify([scope, target, id]); }
  rememberMessage(scope, target, id, data) {
    for (const [key, value] of this.messages) if (this.now() - value.at > 3600000) this.messages.delete(key);
    const key = this.messageKey(scope, target, id);
    this.messages.delete(key); this.messages.set(key, { scope, target, id, at: this.now(), ...data });
    while (this.messages.size > 5000) this.messages.delete(this.messages.keys().next().value);
  }
  message(scope, target, id) { return this.messages.get(this.messageKey(scope, target, id)); }
  async recall(scope, target, id, onError = () => {}) {
    const key = this.messageKey(scope, target, id);
    if (this.recalls.has(key)) return this.recalls.get(key);
    const operation = (async () => { try {
      this.checkOnline(); this.checkTarget(scope, target); boundedString(id, 1024);
      const known = this.message(scope, target, id);
      if (known?.recalled) return true;
      if (known && this.now() - known.at > 120000) throw new AdapterError('RECALL_EXPIRED');
      await this.api.request('DELETE', this.api.route(scope, target, `messages/${encodeURIComponent(id)}`));
      this.rememberMessage(scope, target, id, { ...(known ?? {}), recalled: true }); return true;
    } catch (error) { const safe = safeError(error); onError(safe); logFailure(this.logger, 'recall', safe); return false; } })();
    this.recalls.set(key, operation);
    try { return await operation; } finally { this.recalls.delete(key); }
  }
  deleteMsg(id) {
    const current = eventContext.getStore();
    if (current?.registry === this) return this.recall(current.scope, current.target, id);
    const candidates = [...this.messages.values()].filter(item => item.id === id && item.own);
    if (candidates.length !== 1) return Promise.resolve(false);
    return this.recall(candidates[0].scope, candidates[0].target, id);
  }
  scheduleRecall(scope, target, id, seconds) {
    const handle = this.timers.setTimeout(() => { this.timerHandles.delete(handle); void this.recall(scope, target, id); }, seconds * 1000);
    handle?.unref?.(); this.timerHandles.add(handle);
  }
  async upload(scope, target, file, name, kind = 'file') {
    this.checkOnline(); this.checkTarget(scope, target); const prepared = await prepareMedia(kind, file, this.config, name);
    return uploadMedia(this.api, scope, target, prepared, () => this.checkOnline());
  }
  contact(scope, target, info, reply, rejectUnsupported = unsupported) {
    const send = reply ? (...args) => reply.send(...args) : (...args) => this.send(scope, target, ...args);
    const result = contact(info, send, rejectUnsupported);
    result.segment = richSegment;
    result.recallMsg = id => this.recall(scope, target, id, error => { if (reply) reply.onError({ code: error.code, message: error.message }); else { const current = this.context(scope, target); if (current) current.event.qqbot.lastError = { code: error.code, message: error.message }; } });
    result.sendFile = (file, name) => send({ type: 'file', file, name });
    result.uploadFile = (file, name) => this.upload(scope, target, file, name);
    if (scope === 'group') {
      const group = this.group(target);
      const memberContacts = new Map();
      for (const name of ['getInfo', 'getMembers', 'getMemberMap', 'getMemberInfo', 'muteMember', 'kickMember', 'removeMembers', 'getBotState', 'getMuteState', 'getJoinRequests', 'approveJoinRequest', 'getBlacklist', 'setBlacklist']) result[name] = (...args) => group[name](...args);
      result.getMemberList = async () => [...(await group.getMemberMap()).values()];
      result.renew = async () => Object.assign(result.info, await group.getInfo());
      result.pickMember = id => {
        group.memberId(id);
        if (memberContacts.has(id)) return memberContacts.get(id);
        const cached = this.account.gml.get(group.id)?.get(id) || { user_id: id, nickname: 'QQBot 用户', card: 'QQBot 用户', role: 'member' };
        const member = contact(cached, undefined, rejectUnsupported); member._info = member.info;
        member.renew = async () => Object.assign(member.info, await group.getMemberInfo(id));
        member.getSimpleInfo = () => group.getMemberInfo(id);
        member.mute = seconds => group.muteMember(id, seconds); member.kick = block => group.kickMember(id, block);
        member.muteMember = member.mute; member.kickMember = member.kick;
        memberContacts.set(id, member); return member;
      };
    }
    return result;
  }
  observeMember(groupId, userId, info) {
    if (!this.account.gml.has(groupId)) { if (this.account.gml.size >= 1000) this.account.gml.delete(this.account.gml.keys().next().value); this.account.gml.set(groupId, new Map()); }
    const members = this.account.gml.get(groupId); members.set(userId, info);
    if (members.size > 5000) members.delete(members.keys().next().value);
  }
  #pick(id, kind, list) {
    if (typeof id !== 'string' || !id.startsWith(`${this.id}:${kind}:`) || !list.has(id)) throw new AdapterError('UNSUPPORTED_API');
    return this.contact(kind === 'group' ? 'group' : 'c2c', this.openid(id, kind), list.get(id));
  }
  register() {
    if (this.host[this.id] && this.host[this.id] !== this.account) throw new AdapterError('ACCOUNT_COLLISION');
    this.host[this.id] = this.account;
    owners.set(this.account, this);
  }
  setOnline(value) {
    if (this.host[this.id] !== this.account || owners.get(this.account) !== this) {
      if (value) throw new AdapterError('ACCOUNT_COLLISION');
      return;
    }
    this.online = value;
    if (value) {
      if (this.host.adapter === undefined) this.host.adapter = [];
      if (!Array.isArray(this.host.adapter)) throw new AdapterError('HOST_UNSUPPORTED');
      if (!this.host.adapter.includes(this.id)) this.host.adapter.push(this.id);
    } else if (Array.isArray(this.host.adapter)) {
      // Remove only our ID. Do not replace an array NapCat may still reference.
      for (let i = this.host.adapter.length - 1; i >= 0; i--) if (this.host.adapter[i] === this.id) this.host.adapter.splice(i, 1);
    }
  }
  observe(list, id, info) {
    if (!list.has(id) && list.size >= 1000) list.delete(list.keys().next().value);
    list.set(id, info);
  }
  dispose() {
    this.abort.abort();
    this.releaseSegment();
    for (const handle of this.timerHandles) this.timers.clearTimeout(handle);
    this.timerHandles.clear(); this.messages.clear(); this.recalls.clear();
    this.setOnline(false);
    if (this.host[this.id] === this.account) delete this.host[this.id];
    owners.delete(this.account);
    this.account.fl.clear(); this.account.gl.clear(); this.account.gml.clear();
  }
}
