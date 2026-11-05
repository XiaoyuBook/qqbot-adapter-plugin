import { accountId, identity, UserIdentities } from './identity.js';
import { AdapterError, logFailure, safeError } from './errors.js';
import { makeForwardMsg } from './forward.js';
import { validOpenid } from './config.js';
import { eventContext } from './context.js';
import { GroupOperations, boundedString } from './group.js';
import { PassiveReply } from './reply.js';
import { richSegment } from './rich.js';
import { prepareMedia, uploadMedia } from './media.js';
import { ImageReplies } from './image-reply.js';
import { GroupRequests } from './requests.js';
import { ApprovalStrategies } from './approval-strategies.js';
import { acquireSegmentBridge } from './segment.js';
import { setTimeout as delay } from 'node:timers/promises';

const owners = new WeakMap();
export function contact(info, sendMsg = () => { throw new AdapterError('PASSIVE_ONLY'); }) {
  // Unsupported optional methods must stay absent so capability probes can
  // choose a fallback; concrete contacts install their implemented methods.
  const result = { info: { ...info }, sendMsg, makeForwardMsg };
  for (const key of new Set([...Object.keys(info), 'nickname', 'card', 'role', 'group_name', 'member_count'])) {
    Object.defineProperty(result, key, { enumerable: true, configurable: true, get: () => result.info[key], set: value => { result.info[key] = value; } });
  }
  return result;
}

export class AccountRegistry {
  constructor(host, config, { now = Date.now, logger = globalThis.logger, timers = globalThis, segment = globalThis.segment, sleep } = {}) {
    if (!host || typeof host.emit !== 'function' || Array.isArray(host.uin)) throw new AdapterError('HOST_UNSUPPORTED');
    this.host = host;
    this.config = config;
    this.id = accountId(config.appId);
    this.identities = new UserIdentities(config.appId, config.userIdMappings);
    this.online = false;
    Object.assign(this, { now, logger, timers });
    this.abort = new AbortController();
    this.sleep = sleep ?? (ms => delay(ms, undefined, { signal: this.abort.signal }));
    this.messages = new Map(); this.timerHandles = new Set(); this.recalls = new Map();
    this.groupStates = new Map(); this.groupStatePending = new Map(); this.groupStateQueries = [];
    this.groupRequests = new GroupRequests(this); this.approvalStrategies = new ApprovalStrategies(this);
    this.releaseSegment = acquireSegmentBridge(this, segment);
    this.account = {
      uin: this.id, self_id: this.id, appId: config.appId,
      nickname: 'QQ 官方机器人', adapter: 'QQBot',
      version: { id: 'qqbot-adapter-plugin', version: '0.2.9' },
      fl: new Map(), gl: new Map(), gml: new Map(),
      isOnline: () => this.online,
      pickFriend: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickUser: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickGroup: id => this.#pick(id, 'group', this.account.gl),
      // These are observed contacts, not an enumeration of every platform group.
      getFriendList: async () => new Map(this.account.fl), getGroupList: async () => new Map(this.account.gl),
      getFriendMap: () => new Map(this.account.fl), getGroupMap: () => new Map(this.account.gl),
      makeForwardMsg, segment: richSegment,
      uploadMarkdownImage: async (file, name) => { this.checkOnline(); return this.imageReplies.persistent(await prepareMedia('image', file, { ...this.config, maxImageBytes: Math.min(this.config.maxImageBytes, 10 * 1024 * 1024) }, name)); },
      getMarkdownImages: async (cursor = '') => { this.checkOnline(); boundedString(cursor, 2048, true); return this.api.request('GET', `/v2/media-images${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`); },
      deleteMarkdownImage: async id => { this.checkOnline(); boundedString(id, 256); await this.api.request('DELETE', `/v2/media-images/${encodeURIComponent(id)}/delete`); return true; },
      deleteMsg: id => this.deleteMsg(id),
      getGroupInfo: id => this.group(this.openid(id, 'group')).getInfo(),
      getGroupMemberInfo: (groupId, userId) => this.group(this.openid(groupId, 'group')).getMemberInfo(userId),
      getGroupMemberList: groupId => this.group(this.openid(groupId, 'group')).getMemberMap(),
      pickMember: (groupId, userId) => this.account.pickGroup(groupId).pickMember(userId),
      setGroupBan: (groupId, userId, seconds) => this.group(this.openid(groupId, 'group')).muteMember(userId, seconds),
      setGroupKick: (groupId, userId, block = false, reason = '') => this.group(this.openid(groupId, 'group')).kickMember(userId, reason, block),
      setGroupWholeBan: () => { throw new AdapterError('GROUP_WHOLE_MUTE_UNSUPPORTED'); },
      getSystemMsg: () => this.groupRequests.list(),
      setGroupAddRequest: (...args) => this.groupRequests.approve(...args),
      getJoinApprovalStrategies: (...args) => this.approvalStrategies.list(...args),
      executeJoinApprovalStrategy: (...args) => this.approvalStrategies.execute(...args)
    };
    this.account.sendPrivateMsg = (id, ...args) => this.send('c2c', this.openid(id, 'c2c-user'), ...args);
    this.account.sendGroupMsg = (id, ...args) => this.send('group', this.openid(id, 'group'), ...args);
  }
  bindApi(api) {
    this.api = api;
    if (this.imageReplies?.api !== api) {
      this.imageReplies?.close();
      this.imageReplies = new ImageReplies(api, { logger: this.logger, timers: this.timers });
    }
  }
  checkOnline() { if (!this.online || !this.api) throw new AdapterError('OFFLINE'); }
  checkTarget(scope, target) {
    if (!validOpenid(target)) throw new AdapterError('OPERATION_INVALID');
    const allowed = scope === 'group' ? this.config.allowedGroupOpenids : this.config.allowedC2COpenids;
    if (allowed.length && !allowed.includes(target)) throw new AdapterError('TARGET_DENIED');
  }
  openid(id, kind) {
    if (kind === 'group-user' || kind === 'c2c-user') return this.identities.openid(id, kind);
    const prefix = `${this.id}:${kind}:`;
    if (typeof id !== 'string' || !id.startsWith(prefix) || !validOpenid(id.slice(prefix.length))) throw new AdapterError('OPERATION_INVALID');
    return id.slice(prefix.length);
  }
  userId(kind, openid) { return this.identities.userId(kind, openid); }
  group(target) { return new GroupOperations(this, target); }
  currentContext() { const current = eventContext.getStore(); return current?.registry === this ? current : null; }
  observeGroupState(target, data) {
    if (!this.online) return;
    if (!this.groupStates.has(target) && this.groupStates.size >= 1000) this.groupStates.delete(this.groupStates.keys().next().value);
    this.groupStates.set(target, { value: { member_openid: data.member_openid, member_role: data.member_role }, expiresAt: this.now() + 60000 });
    const groupId = identity(this.config.appId, 'group', target), userId = this.userId('group-user', data.member_openid);
    this.observeMember(groupId, userId, { user_id: userId, nickname: this.account.nickname, card: this.account.nickname, role: data.member_role, is_admin: ['admin', 'owner'].includes(data.member_role), is_owner: data.member_role === 'owner' });
  }
  async ensureGroupState(target) {
    this.checkTarget('group', target);
    const cached = this.groupStates.get(target);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    if (this.groupStatePending.has(target)) return cached?.value ?? this.groupStatePending.get(target);
    this.groupStateQueries = this.groupStateQueries.filter(at => this.now() - at < 60000);
    if (this.groupStateQueries.length >= 25) return cached?.value;
    this.groupStateQueries.push(this.now());
    const operation = this.group(target).getBotState().catch(error => {
      if (this.online) {
        if (!this.groupStates.has(target) && this.groupStates.size >= 1000) this.groupStates.delete(this.groupStates.keys().next().value);
        this.groupStates.set(target, { value: undefined, expiresAt: this.now() + 30000 });
        logFailure(this.logger, 'group_state', error);
      }
      return undefined;
    }).finally(() => this.groupStatePending.delete(target));
    this.groupStatePending.set(target, operation);
    // Existing groups refresh in the background; their ordinary image replies
    // do not wait for a role query on every cache expiry.
    return cached ? cached.value : operation;
  }
  context(scope, target) { const current = eventContext.getStore(); return current?.registry === this && current.scope === scope && current.target === target ? current : null; }
  send(scope, target, ...args) {
    this.checkTarget(scope, target);
    const current = this.context(scope, target);
    if (current?.reply) return current.reply.send(...args);
    if (!this.config.allowProactive) throw new AdapterError('PASSIVE_ONLY');
    if (!(scope === 'group' ? this.account.gl : this.account.fl).has(scope === 'group' ? identity(this.config.appId, 'group', target) : this.userId('c2c-user', target))) throw new AdapterError('MESSAGE_UNKNOWN');
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
  contact(scope, target, info, reply) {
    const send = reply ? (...args) => reply.send(...args) : (...args) => this.send(scope, target, ...args);
    const result = contact(info, send);
    result.getInfo = async () => ({ ...result.info });
    if (scope === 'c2c') result.getSimpleInfo = result.getInfo;
    result.segment = richSegment;
    result.recallMsg = id => this.recall(scope, target, id, error => { if (reply) reply.onError({ code: error.code, message: error.message }); else { const current = this.context(scope, target); if (current) current.event.qqbot.lastError = { code: error.code, message: error.message }; } });
    result.sendFile = (file, name) => send({ type: 'file', file, name });
    result.uploadFile = (file, name) => this.upload(scope, target, file, name);
    if (scope === 'group') {
      const group = this.group(target);
      const memberContacts = new Map();
      Object.defineProperties(result, {
        is_admin: { enumerable: true, get: () => ['admin', 'owner'].includes(this.groupStates.get(target)?.value?.member_role) },
        is_owner: { enumerable: true, get: () => this.groupStates.get(target)?.value?.member_role === 'owner' }
      });
      for (const name of ['getInfo', 'getMembers', 'getMemberMap', 'getMemberInfo', 'muteMember', 'kickMember', 'removeMembers', 'getBotState', 'getMuteState', 'getMutedMembers', 'getJoinRequests', 'approveJoinRequest', 'getBlacklist', 'setBlacklist']) result[name] = (...args) => group[name](...args);
      result.mute = result.muteMember; result.kick = result.kickMember;
      result.muteAll = () => { throw new AdapterError('GROUP_WHOLE_MUTE_UNSUPPORTED'); };
      result.executeJoinApprovalStrategy = id => this.approvalStrategies.execute(id, target);
      result.getMemberList = async () => [...(await group.getMemberMap()).values()];
      result.renew = async () => Object.assign(result.info, await group.getInfo());
      result.pickMember = id => {
        id = this.userId('group-user', group.memberId(id));
        if (memberContacts.has(id)) return memberContacts.get(id);
        const cached = this.account.gml.get(group.id)?.get(id) || { user_id: id, nickname: 'QQBot 用户', card: 'QQBot 用户', role: 'member' };
        cached.group_id = group.id;
        const member = contact(cached); member.info = cached; member._info = member.info;
        member.group = result;
        Object.defineProperties(member, {
          is_admin: { enumerable: true, get: () => ['admin', 'owner'].includes(member.info.role) },
          is_owner: { enumerable: true, get: () => member.info.role === 'owner' }
        });
        member.renew = async () => Object.assign(member.info, await group.getMemberInfo(id));
        member.getInfo = member.renew; member.getSimpleInfo = member.renew;
        member.mute = seconds => group.muteMember(id, seconds); member.kick = (...args) => group.kickMember(id, ...args);
        member.muteMember = member.mute; member.kickMember = member.kick;
        memberContacts.set(id, member); return member;
      };
    }
    return result;
  }
  observeMember(groupId, userId, info) {
    if (!this.account.gml.has(groupId)) { if (this.account.gml.size >= 1000) this.account.gml.delete(this.account.gml.keys().next().value); this.account.gml.set(groupId, new Map()); }
    const members = this.account.gml.get(groupId);
    if (members.has(userId)) Object.assign(members.get(userId), info);
    else members.set(userId, info);
    if (members.size > 5000) members.delete(members.keys().next().value);
  }
  #pick(id, kind, list) {
    let openid;
    try { openid = this.openid(id, kind); } catch { throw new AdapterError('UNSUPPORTED_API'); }
    const key = kind === 'group' ? identity(this.config.appId, kind, openid) : this.userId(kind, openid);
    if (!list.has(key)) throw new AdapterError('UNSUPPORTED_API');
    return this.contact(kind === 'group' ? 'group' : 'c2c', openid, list.get(key));
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
    list.set(id, { ...info, uin: this.id, ...(list === this.account.gl ? { group_name: info.group_name ?? info.name } : {}) });
  }
  dispose() {
    this.abort.abort();
    this.imageReplies?.close();
    this.releaseSegment();
    for (const handle of this.timerHandles) this.timers.clearTimeout(handle);
    this.timerHandles.clear(); this.messages.clear(); this.recalls.clear();
    this.groupStates.clear(); this.groupStatePending.clear(); this.groupStateQueries = []; this.groupRequests.close();
    this.setOnline(false);
    if (this.host[this.id] === this.account) delete this.host[this.id];
    owners.delete(this.account);
    this.account.fl.clear(); this.account.gl.clear(); this.account.gml.clear();
  }
}
