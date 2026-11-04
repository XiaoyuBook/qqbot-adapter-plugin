import { validOpenid } from './config.js';
import { boundedString } from './group.js';
import { AdapterError } from './errors.js';

export class ApprovalStrategies {
  constructor(registry) { this.registry = registry; }
  async list(cursor = '', limit = 20) {
    this.registry.checkOnline(); boundedString(cursor, 2048, true);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AdapterError('OPERATION_INVALID');
    const data = await this.registry.api.request('GET', `/v2/groups/join_approval_strategy?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`);
    if (!Array.isArray(data.strategies) || data.strategies.length > limit || (data.next_cursor !== undefined && typeof data.next_cursor !== 'string')) throw new AdapterError('API_RESPONSE');
    return data;
  }
  async execute(strategyId, target) {
    this.registry.checkOnline(); if (!validOpenid(strategyId)) throw new AdapterError('OPERATION_INVALID');
    if (target) this.registry.checkTarget('group', target);
    const current = this.registry.currentContext();
    if (current && current.scope !== 'group') throw new AdapterError('TARGET_DENIED');
    if (current && target && target !== current.target) throw new AdapterError('TARGET_DENIED');
    target ??= current?.target;
    const cursors = new Set(); let cursor = '', strategy;
    for (let page = 0; page < 100; page++) {
      if (page) await this.registry.sleep(1100);
      const data = await this.list(cursor, 50);
      strategy = data.strategies.find(item => item?.strategy_id === strategyId);
      if (strategy || !data.next_cursor) break;
      if (cursors.has(data.next_cursor) || page === 99) throw new AdapterError('API_RESPONSE');
      cursors.add(data.next_cursor); cursor = data.next_cursor;
    }
    if (!strategy) throw new AdapterError('MESSAGE_UNKNOWN');
    if (strategy.is_enable !== 'on' || !Number.isFinite(Date.parse(strategy.expire_at)) || Date.parse(strategy.expire_at) <= this.registry.now()) throw new AdapterError('OPERATION_INVALID');
    const groups = strategy.group_openids, opaqueGroups = strategy.group_ids;
    // Execution scans ALL associated groups. Never treat it as single-group
    // approval or infer OpenIDs from masked numeric QQ group identifiers.
    if (target || this.registry.config.allowedGroupOpenids.length) {
      if (!Array.isArray(groups) || !groups.length || groups.some(id => !validOpenid(id)) || (opaqueGroups !== undefined && (!Array.isArray(opaqueGroups) || opaqueGroups.length))) throw new AdapterError('TARGET_DENIED');
      groups.forEach(id => this.registry.checkTarget('group', id));
      if (target && groups.some(id => id !== target)) throw new AdapterError('TARGET_DENIED');
    }
    await this.registry.api.request('POST', `/v2/groups/join_approval_strategy/${strategyId}/execute`, {});
    return { accepted: true, strategy_id: strategyId };
  }
}
