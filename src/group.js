import { identity } from './identity.js';
import { validOpenid } from './config.js';
import { AdapterError } from './errors.js';

const invalid = () => { throw new AdapterError('OPERATION_INVALID'); };
export function boundedString(value, max = 2048, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max || /[\0\r\n]/.test(value)) invalid();
  return value;
}
export function role(value) { return ['member', 'admin', 'owner'].includes(value) ? value : 'member'; }
export class GroupOperations {
  constructor(registry, target) { registry.checkTarget('group', target); this.registry = registry; this.target = target; this.id = identity(registry.config.appId, 'group', target); }
  memberId(value) { return this.registry.openid(value, 'group-user'); }
  async request(method, resource, body, query) {
    this.registry.checkOnline();
    let route = this.registry.api.route('group', this.target, resource);
    if (query) route += `?${new URLSearchParams(query)}`;
    return this.registry.api.request(method, route, body);
  }
  member(data) {
    if (!validOpenid(data?.member_openid)) throw new AdapterError('API_RESPONSE');
    const userId = identity(this.registry.config.appId, 'group-user', data.member_openid);
    const info = { user_id: userId, nickname: typeof data.username === 'string' ? data.username : 'QQBot 用户', card: typeof data.username === 'string' ? data.username : 'QQBot 用户', role: role(data.member_role), is_admin: ['admin', 'owner'].includes(data.member_role), is_owner: data.member_role === 'owner', ...(Number.isFinite(Date.parse(data.joined_at)) ? { join_time: Math.floor(Date.parse(data.joined_at) / 1000) } : {}) };
    this.registry.observeMember(this.id, userId, info);
    return info;
  }
  async getInfo() {
    const data = await this.request('GET', 'info');
    if (data.group_openid !== this.target || typeof data.group_name !== 'string') throw new AdapterError('API_RESPONSE');
    const info = { group_id: this.id, group_name: typeof data.group_name === 'string' ? data.group_name : 'QQBot 群', name: typeof data.group_name === 'string' ? data.group_name : 'QQBot 群', member_count: Number.isInteger(data.group_member_num) ? data.group_member_num : undefined, description: typeof data.group_finger_memo === 'string' ? data.group_finger_memo : '' };
    this.registry.observe(this.registry.account.gl, this.id, info); return info;
  }
  async getMembers(cursor = '') {
    boundedString(cursor, 2048, true);
    const data = await this.request('GET', 'members', undefined, cursor ? { cursor } : undefined);
    if (!Array.isArray(data.members) || data.members.length > 30 || (data.next_cursor !== undefined && typeof data.next_cursor !== 'string')) throw new AdapterError('API_RESPONSE');
    return { members: data.members.map(item => this.member(item)), next_cursor: data.next_cursor || '' };
  }
  async getMemberMap() {
    const members = new Map(), cursors = new Set(); let cursor = '';
    for (let page = 0; page < 100; page++) {
      if (page) await this.registry.sleep(1100);
      const data = await this.getMembers(cursor);
      for (const item of data.members) members.set(item.user_id, item);
      if (!data.next_cursor) return members;
      if (cursors.has(data.next_cursor)) throw new AdapterError('API_RESPONSE');
      cursors.add(data.next_cursor); cursor = data.next_cursor;
    }
    throw new AdapterError('API_RESPONSE');
  }
  async getMemberInfo(userId) { return this.member(await this.request('GET', `members/${this.memberId(userId)}`)); }
  async muteMember(userId, seconds = 1800) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30 * 86400) invalid();
    await this.request('POST', 'restrict_chat_setting', { members: [{ op: seconds ? 'add' : 'del', member_openid: this.memberId(userId), mute_expire_at: seconds ? new Date(this.registry.now() + seconds * 1000).toISOString() : '' }] });
    return true;
  }
  async kickMember(userId, block = false) { return this.removeMembers([userId], block); }
  async removeMembers(userIds, block = false) {
    if (!Array.isArray(userIds) || !userIds.length || userIds.length > 20 || typeof block !== 'boolean') invalid();
    const data = await this.request('POST', 'batch_remove_members', { member_openids: [...new Set(userIds.map(id => this.memberId(id)))], add_to_member_blacklist: block });
    if (data.remove_members_result !== 'success') throw new AdapterError('API_RESPONSE');
    if ((block && !Array.isArray(data.add_to_member_blacklist_fail_openids)) || data.add_to_member_blacklist_fail_openids?.length) throw new AdapterError('PARTIAL_FAILURE');
    return true;
  }
  async getBotState() { const data = await this.request('GET', 'bot_state'); if (!validOpenid(data.member_openid) || !['member', 'admin', 'owner'].includes(data.member_role)) throw new AdapterError('API_RESPONSE'); return data; }
  async getMuteState() { const data = await this.request('GET', 'restrict_chat_setting'); if (!Array.isArray(data.members) || !data.global_rule) throw new AdapterError('API_RESPONSE'); return data; }
  async getJoinRequests(cursor = '', limit = 20) {
    boundedString(cursor, 2048, true); if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
    const data = await this.request('GET', 'join_request_list', undefined, { ...(cursor ? { cursor } : {}), limit: String(limit) });
    if (!Array.isArray(data.list) || data.list.length > limit || (data.next_cursor !== undefined && typeof data.next_cursor !== 'string')) throw new AdapterError('API_RESPONSE'); return data;
  }
  async approveJoinRequest(userId, requestId, approve = true, reason = '', block = false) {
    boundedString(requestId, 1024); boundedString(reason, 500, true);
    if (typeof approve !== 'boolean' || typeof block !== 'boolean' || (approve && block)) invalid();
    await this.request('POST', `approval_join_request/${this.memberId(userId)}`, { op: approve ? 'approve' : 'decline', join_request_id: requestId, ...(!approve ? { reject_reason: reason, add_to_member_blacklist: block } : {}) });
    return true;
  }
  async getBlacklist(cursor = '', limit = 20) {
    boundedString(cursor, 2048, true); if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
    const data = await this.request('GET', 'member_blacklist', undefined, { ...(cursor ? { cursor } : {}), limit: String(limit) });
    if (!Array.isArray(data.users) || data.users.length > limit || (data.next_cursor !== undefined && typeof data.next_cursor !== 'string')) throw new AdapterError('API_RESPONSE'); return data;
  }
  async setBlacklist(userIds, add = true) {
    if (!Array.isArray(userIds) || !userIds.length || userIds.length > 20 || typeof add !== 'boolean') invalid();
    const data = await this.request('POST', 'member_blacklist', { op: add ? 'add' : 'del', member_openids: [...new Set(userIds.map(id => this.memberId(id)))] });
    if (!Array.isArray(data.fail_openids)) throw new AdapterError('API_RESPONSE');
    if (data.fail_openids.length) throw new AdapterError('PARTIAL_FAILURE');
    return true;
  }
}
