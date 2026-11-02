import { accountId } from './identity.js';
import { AdapterError, unsupported } from './errors.js';

const owners = new WeakMap();
const unsupportedMethods = ['getAvatarUrl', 'getChatHistory', 'recallMsg', 'makeForwardMsg', 'getMemberMap', 'getMemberList', 'muteMember', 'muteAll', 'kickMember', 'setCard', 'setName', 'setAdmin', 'pokeMember', 'sendFile', 'uploadFile', 'thumbUp', 'getSimpleInfo', 'getFileUrl', 'mute', 'kick', 'poke', 'quit', 'setTitle', 'renew'];

export function contact(info, sendMsg = () => { throw new AdapterError('PASSIVE_ONLY'); }, rejectUnsupported = unsupported) {
  const result = { ...info, info: { ...info }, sendMsg };
  for (const name of unsupportedMethods) result[name] = rejectUnsupported;
  return result;
}

export class AccountRegistry {
  constructor(host, config) {
    if (!host || typeof host.emit !== 'function' || Array.isArray(host.uin)) throw new AdapterError('HOST_UNSUPPORTED');
    this.host = host;
    this.config = config;
    this.id = accountId(config.appId);
    this.online = false;
    this.account = {
      uin: this.id, self_id: this.id, appId: config.appId,
      nickname: 'QQ 官方机器人', adapter: 'QQBot',
      version: { id: 'qqbot-adapter-plugin', version: '0.1.1' },
      fl: new Map(), gl: new Map(), gml: new Map(),
      isOnline: () => this.online,
      pickFriend: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickUser: id => this.#pick(id, 'c2c-user', this.account.fl),
      pickGroup: id => this.#pick(id, 'group', this.account.gl),
      getFriendList: unsupported, getGroupList: unsupported,
      sendPrivateMsg: () => { throw new AdapterError('PASSIVE_ONLY'); },
      sendGroupMsg: () => { throw new AdapterError('PASSIVE_ONLY'); },
      makeForwardMsg: unsupported, deleteMsg: unsupported, getMsg: unsupported
    };
  }
  #pick(id, kind, list) {
    if (typeof id !== 'string' || !id.startsWith(`${this.id}:${kind}:`) || !list.has(id)) throw new AdapterError('UNSUPPORTED_API');
    return contact(list.get(id));
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
    this.setOnline(false);
    if (this.host[this.id] === this.account) delete this.host[this.id];
    owners.delete(this.account);
    this.account.fl.clear(); this.account.gl.clear(); this.account.gml.clear();
  }
}
