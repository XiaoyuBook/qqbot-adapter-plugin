import { randomUUID } from 'node:crypto';
import { validOpenid } from './config.js';
import { AdapterError } from './errors.js';

export class GroupRequests {
  constructor(registry) { this.registry = registry; this.records = new Map(); }
  prune() {
    for (const [flag, record] of this.records) if (this.registry.now() - record.observedAt > 3600000 && !record.pending) this.records.delete(flag);
  }
  observe(target, data) {
    this.registry.checkTarget('group', target);
    if (!validOpenid(data?.member_openid) || typeof data.join_request_id !== 'string' || !data.join_request_id || data.join_request_id.length > 1024 || !Number.isFinite(Date.parse(data.apply_at))) throw new AdapterError('EVENT_INVALID');
    this.prune();
    let record = [...this.records.values()].find(item => item.target === target && item.requestId === data.join_request_id);
    if (record && record.openid !== data.member_openid) throw new AdapterError('EVENT_INVALID');
    if (!record) {
      if (this.records.size >= 1000) throw new AdapterError('OPERATION_INVALID');
      record = { flag: `qqbot-request:${randomUUID()}`, target, requestId: data.join_request_id, openid: data.member_openid };
      this.records.set(record.flag, record);
    }
    Object.assign(record, { observedAt: this.registry.now(), nickname: typeof data.username === 'string' ? data.username.slice(0, 200) : 'QQBot 用户', time: Math.floor(Date.parse(data.apply_at) / 1000), comment: typeof data.verify_info?.verify_message === 'string' ? data.verify_info.verify_message.slice(0, 4000) : '', tips: typeof data.risk_tips === 'string' ? data.risk_tips.slice(0, 4000) : '' });
    return this.view(record);
  }
  view(record) {
    return { flag: record.flag, request_type: 'group', sub_type: 'add', group_id: `${this.registry.id}:group:${record.target}`, user_id: this.registry.userId('group-user', record.openid), nickname: record.nickname, comment: record.comment, tips: record.tips, time: record.time, approve: (approve = true, reason = '', block = false) => this.approve(record.flag, approve, reason, block) };
  }
  async list() {
    this.registry.checkOnline(); this.prune();
    const current = this.registry.currentContext();
    if (current?.scope === 'group') {
      const group = this.registry.group(current.target), cursors = new Set(); let cursor = '';
      for (let page = 0; page < 100; page++) {
        if (page) await this.registry.sleep(2100);
        const response = await group.getJoinRequests(cursor, 50);
        for (const data of response.list) this.observe(current.target, data);
        if (!response.next_cursor) break;
        if (cursors.has(response.next_cursor) || page === 99) throw new AdapterError('API_RESPONSE');
        cursors.add(response.next_cursor); cursor = response.next_cursor;
      }
    }
    return [...this.records.values()].filter(item => !item.resolved && (!current || current.scope === 'group' && item.target === current.target)).map(item => this.view(item));
  }
  async approve(flag, approve = true, reason = '', block = false) {
    this.registry.checkOnline(); this.prune();
    const record = this.records.get(flag);
    if (!record) throw new AdapterError('MESSAGE_UNKNOWN');
    if (typeof approve !== 'boolean' || typeof block !== 'boolean' || typeof reason !== 'string' || reason.length > 500 || /[\0\r\n]/.test(reason) || (approve && block)) throw new AdapterError('OPERATION_INVALID');
    const current = this.registry.currentContext();
    if (current && (current.scope !== 'group' || current.target !== record.target)) throw new AdapterError('TARGET_DENIED');
    const decision = JSON.stringify([approve, reason, block]);
    if (record.decision !== undefined && record.decision !== decision) throw new AdapterError('OPERATION_INVALID');
    if (record.resolved) return true;
    if (record.pending) return record.pending;
    record.decision = decision;
    const operation = this.registry.group(record.target).approveJoinRequest(this.registry.userId('group-user', record.openid), record.requestId, approve, reason, block);
    record.pending = operation;
    try { await operation; record.resolved = true; return true; }
    catch (error) { delete record.decision; throw error; }
    finally { delete record.pending; }
  }
  close() { this.records.clear(); }
}
