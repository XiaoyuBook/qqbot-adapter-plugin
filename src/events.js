import { validOpenid } from './config.js';
import { identity, fixMaster, isMaster } from './identity.js';
import { PassiveReply, installReply } from './reply.js';
import { AdapterError } from './errors.js';
import { eventContext } from './context.js';
import { role } from './group.js';
import { richSegment } from './rich.js';
import { incomingMessage } from './incoming.js';

function groupContent(message, mentions, ownIds, registry, wasMentioned) {
  const known = new Map(), seen = new Set(), parts = [], texts = [];
  if (mentions !== undefined && (!Array.isArray(mentions) || mentions.length > 100)) throw new AdapterError('EVENT_INVALID');
  for (const item of mentions ?? []) {
    const id = item?.member_openid ?? item?.id;
    if (validOpenid(id)) known.set(id, item);
  }
  let firstText = true;
  for (const part of message) {
    if (part.type !== 'text') { parts.push(part); continue; }
    let content = part.text;
    if (firstText) {
      for (const id of ownIds) content = content.replace(new RegExp(`^\\s*<@!?${id}>\\s*`), () => { wasMentioned = true; return ''; });
      content = content.trimStart(); firstText = false;
    }
    texts.push(content);
    let offset = 0;
    for (const match of content.matchAll(/<@!?([A-Za-z0-9_-]{1,128})>/g)) {
      const id = match[1];
      // Typed tag-like text alone cannot supply an identity or disappear.
      if (!known.has(id)) continue;
      if (match.index > offset) parts.push({ type: 'text', text: content.slice(offset, match.index) });
      if (ownIds.has(id)) wasMentioned = true;
      else parts.push({ type: 'at', qq: registry.userId('group-user', id), text: typeof known.get(id).username === 'string' ? known.get(id).username.slice(0, 200) : '' });
      seen.add(id); offset = match.index + match[0].length;
    }
    if (offset < content.length) parts.push({ type: 'text', text: content.slice(offset) });
  }
  const remaining = [];
  for (const [id, item] of known) if (!seen.has(id) && !ownIds.has(id)) remaining.push({ type: 'at', qq: registry.userId('group-user', id), text: typeof item.username === 'string' ? item.username.slice(0, 200) : '' });
  const mediaIndex = parts.findIndex(part => !['text', 'at'].includes(part.type));
  parts.splice(mediaIndex < 0 ? parts.length : mediaIndex, 0, ...remaining);
  return { content: texts.join('\n'), parts, atBot: wasMentioned };
}

export class EventDeduplicator {
  constructor({ now = Date.now, ttlMs = 7200000, max = 20000 } = {}) { Object.assign(this, { now, ttlMs, max }); this.seen = new Map(); }
  claim(key) {
    const now = this.now();
    for (const [id, expiry] of this.seen) {
      if (expiry > now) break;
      this.seen.delete(id);
    }
    if (this.seen.has(key)) return false;
    // Fail closed at capacity rather than evicting a live entry and rerunning it.
    if (this.seen.size >= this.max) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }
}

export class EventMapper {
  constructor({ registry, api, config, logger, now = Date.now, dedup = new EventDeduplicator({ now }) }) {
    Object.assign(this, { registry, api, config, logger, now, dedup });
    registry.bindApi(api);
    this.platformBotId = null;
  }
  async dispatch(payload) {
    if (payload.t === 'INTERACTION_CREATE') return this.interaction(payload);
    if (['GROUP_JOIN_REQUEST', 'GROUP_MEMBER_ADD', 'GROUP_MEMBER_REMOVE', 'GROUP_ADD_ROBOT', 'GROUP_DEL_ROBOT', 'GROUP_MSG_RECEIVE', 'GROUP_MSG_REJECT'].includes(payload.t)) return this.groupNotice(payload);
    const scope = ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(payload.t) ? 'group' : payload.t === 'C2C_MESSAGE_CREATE' ? 'c2c' : null;
    if (payload.t === 'GROUP_MESSAGE_CREATE' && !this.config.receiveGroupMessages) return false;
    if (!scope || !this.registry.online || !(scope === 'group' ? this.config.receiveGroup : this.config.receiveC2C)) return false;
    const d = payload.d;
    if (d?.author?.bot === true) return false;
    const openid = scope === 'group' ? d?.author?.member_openid : d?.author?.user_openid;
    const target = scope === 'group' ? d?.group_openid : openid;
    if (!validOpenid(openid) || !validOpenid(target) || typeof d?.id !== 'string' || !d.id || d.id.length > 512 || (d.content !== undefined && (typeof d.content !== 'string' || d.content.length > 64000)) || (d.attachments !== undefined && (!Array.isArray(d.attachments) || d.attachments.length > 10))) throw new AdapterError('EVENT_INVALID');
    const allowed = scope === 'group' ? this.config.allowedGroupOpenids : this.config.allowedC2COpenids;
    if (allowed.length && !allowed.includes(target)) return false;
    const timestamp = Date.parse(d.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > this.now() + 60000) throw new AdapterError('EVENT_INVALID');
    // Never turn an old replay into a fresh passive send window.
    const createdAt = Math.min(this.now(), timestamp);
    if (this.now() - createdAt > (scope === 'c2c' ? this.config.c2cReplyWindowSeconds : this.config.replyWindowSeconds) * 1000) return false;
    const key = JSON.stringify([this.config.appId, scope, target, d.id]);
    if (!this.dedup.claim(key)) return false;
    if (scope === 'group' && this.config.groupManagement) {
      await this.registry.ensureGroupState(target);
      if (!this.registry.online) return false;
    }
    const principalId = identity(this.config.appId, scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const userId = this.registry.userId(scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const groupId = scope === 'group' ? identity(this.config.appId, 'group', target) : undefined;
    const ownIds = new Set([this.platformBotId, this.registry.groupStates.get(target)?.value?.member_openid].filter(validOpenid));
    const incoming = incomingMessage(d, scope);
    const parsed = scope === 'group' ? groupContent(incoming.parts, d.mentions, ownIds, this.registry, payload.t === 'GROUP_AT_MESSAGE_CREATE') : { content: incoming.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'), parts: incoming.parts, atBot: false };
    const content = parsed.content;
    const nickname = typeof d.author.username === 'string' && d.author.username.length <= 200 ? d.author.username : 'QQBot 用户';
    const sender = { user_id: userId, nickname, card: nickname, role: role(d.author.member_role) };
    const atBot = parsed.atBot;
    const ext = Array.isArray(d.message_scene?.ext) ? d.message_scene.ext.filter(item => typeof item === 'string' && item.length <= 4096) : [];
    const referenceId = ext.find(item => item.startsWith('msg_idx='))?.slice(8);
    const sourceReference = ext.find(item => item.startsWith('ref_msg_idx='))?.slice(12);
    const event = {
      bot: this.registry.account,
      self_id: this.registry.id, post_type: 'message', message_type: scope === 'group' ? 'group' : 'private',
      sub_type: scope === 'group' ? 'normal' : 'friend',
      user_id: userId, ...(groupId ? { group_id: groupId, group_name: 'QQBot 群' } : {}),
      message_id: d.id, time: Math.floor(timestamp / 1000), raw_message: content,
      sender, message: [], adapter: 'QQBot',
      isGroup: scope === 'group', isPrivate: scope === 'c2c', atBot,
      qqbot: { appId: this.config.appId, scope, principalId, userOpenid: openid, ...(scope === 'group' ? { groupOpenid: target } : {}), eventId: typeof payload.id === 'string' ? payload.id : undefined, referenceId, unsupportedAttachments: incoming.unsupportedAttachments, incoming: incoming.summary, compatibility: [], lastError: null, segment: richSegment }
    };
    if (atBot) event.message.push({ type: 'at', qq: this.registry.id, text: 'QQ 官方机器人' });
    event.message.push(...parsed.parts);
    fixMaster(event, isMaster(this.config, scope, openid));
    if (sourceReference) event.source = { message_id: sourceReference, ref_idx: sourceReference, message: [] };
    this.registry.rememberMessage(scope, target, d.id, { own: false, at: timestamp, ref_idx: referenceId });
    const reply = new PassiveReply({ registry: this.registry, api: this.api, config: this.config, scope, target, senderId: userId, messageId: d.id, referenceId, createdAt, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => { if (!event.qqbot.compatibility.includes(code)) event.qqbot.compatibility.push(code); } });
    installReply(event, reply);
    const userInfo = { user_id: userId, nickname: sender.nickname, card: sender.card, role: sender.role };
    if (scope === 'group') {
      this.registry.observeMember(groupId, userId, { ...userInfo, is_admin: ['admin', 'owner'].includes(sender.role), is_owner: sender.role === 'owner' });
      const group = this.registry.contact(scope, target, this.registry.account.gl.get(groupId) ?? { group_id: groupId, name: 'QQBot 群', group_name: 'QQBot 群', mute_left: 0 }, reply);
      const member = group.pickMember(userId);
      event.group = group;
      event.member = member;
      this.registry.observe(this.registry.account.gl, groupId, group.info);
    } else {
      event.friend = this.registry.contact(scope, target, userInfo, reply);
      this.registry.observe(this.registry.account.fl, userId, userInfo);
    }
    if (!content && !event.message.some(part => ['image', 'video', 'record', 'file'].includes(part.type)) && event.qqbot.unsupportedAttachments.length) {
      await reply.fail(new AdapterError('UNSUPPORTED_MESSAGE'));
      return false;
    }
    // ICQQ TripTrap emits only the named root. Never also emit message.group or
    // call PluginsLoader.deal: either would run the same business handler twice.
    if (incoming.summary.cards || incoming.summary.skippedHistory) {
      const { messageType, cards, mappedCards, ignoredCards, skippedHistory, skippedAuthors } = incoming.summary;
      this.logger?.info?.(`[qqbot-adapter-plugin] incoming_card type=${messageType ?? 'legacy'} cards=${cards} mapped=${mappedCards} ignored=${ignoredCards} history=${skippedHistory} authors=${skippedAuthors}`);
      if (incoming.summary.ignoredCardSchemas) this.logger?.info?.(`[qqbot-adapter-plugin] incoming_card_schema ${JSON.stringify(incoming.summary.ignoredCardSchemas)}`);
    }
    eventContext.run({ registry: this.registry, event, reply, scope, target }, () => this.registry.host.emit('message', event));
    return event;
  }

  async interaction(payload) {
    const d = payload.d;
    if (!this.registry.online || !d || ![11, 12].includes(d.type)) return false;
    const scope = d.scene === 'group' || d.chat_type === 1 ? 'group' : d.scene === 'c2c' || d.chat_type === 2 ? 'c2c' : null;
    if (!scope || !(scope === 'group' ? this.config.receiveGroup : this.config.receiveC2C)) return false;
    const openid = scope === 'group' ? d.group_member_openid : d.user_openid, target = scope === 'group' ? d.group_openid : openid;
    if (!validOpenid(openid) || !validOpenid(target) || typeof d.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(d.id)) throw new AdapterError('EVENT_INVALID');
    const allowed = scope === 'group' ? this.config.allowedGroupOpenids : this.config.allowedC2COpenids;
    const timestamp = Date.parse(d.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > this.now() + 60000 || this.now() - timestamp > (scope === 'c2c' ? this.config.c2cReplyWindowSeconds : this.config.replyWindowSeconds) * 1000) return false;
    if (d.application_id !== undefined && String(d.application_id) !== this.config.appId) throw new AdapterError('EVENT_INVALID');
    if (!this.dedup.claim(JSON.stringify([this.config.appId, 'interaction', d.id]))) return false;
    if (allowed.length && !allowed.includes(target)) { await this.api.request('PUT', `/interactions/${encodeURIComponent(d.id)}`, { code: 4 }); return false; }
    await this.api.request('PUT', `/interactions/${encodeURIComponent(d.id)}`, { code: 0 });
    const userId = this.registry.userId(scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const groupId = scope === 'group' ? identity(this.config.appId, 'group', target) : undefined;
    const resolved = d.data?.resolved ?? {};
    const event = { bot: this.registry.account, self_id: this.registry.id, post_type: 'notice', notice_type: 'qqbot', sub_type: 'button', user_id: userId, ...(groupId ? { group_id: groupId } : {}), time: Math.floor(timestamp / 1000), isGroup: scope === 'group', isPrivate: scope === 'c2c', adapter: 'QQBot', sender: { user_id: userId, nickname: 'QQBot 用户', role: 'member' }, qqbot: { appId: this.config.appId, scope, userOpenid: openid, ...(groupId ? { groupOpenid: target } : {}), interactionId: d.id, eventId: typeof payload.id === 'string' ? payload.id : d.id, buttonId: typeof resolved.button_id === 'string' ? resolved.button_id.slice(0, 256) : '', buttonData: typeof resolved.button_data === 'string' ? resolved.button_data.slice(0, 4096) : '', acknowledged: true, compatibility: [], lastError: null, segment: richSegment } };
    fixMaster(event, isMaster(this.config, scope, openid));
    const reply = new PassiveReply({ registry: this.registry, api: this.api, config: this.config, scope, target, senderId: userId, eventId: event.qqbot.eventId, createdAt: timestamp, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => event.qqbot.compatibility.push(code) });
    installReply(event, reply);
    const info = groupId ? this.registry.account.gl.get(groupId) ?? { group_id: groupId, name: 'QQBot 群' } : { user_id: userId, nickname: 'QQBot 用户' };
    if (groupId) { event.group = this.registry.contact(scope, target, info, reply); event.member = event.group.pickMember(userId); this.registry.observe(this.registry.account.gl, groupId, info); }
    else { event.friend = this.registry.contact(scope, target, info, reply); this.registry.observe(this.registry.account.fl, userId, info); }
    // Callback data stays notice data; never execute opaque callback values as commands.
    eventContext.run({ registry: this.registry, event, reply, scope, target }, () => this.registry.host.emit('notice', event));
    return event;
  }

  async groupNotice(payload) {
    if (!this.registry.online || !this.config.receiveGroup || !this.config.receiveGroupNotices) return false;
    const d = payload.d;
    if (!d || !validOpenid(d.group_openid)) throw new AdapterError('EVENT_INVALID');
    const target = d.group_openid, openid = d.member_openid ?? d.op_member_openid;
    if (!validOpenid(openid)) throw new AdapterError('EVENT_INVALID');
    if (this.config.allowedGroupOpenids.length && !this.config.allowedGroupOpenids.includes(target)) return false;
    const groupId = identity(this.config.appId, 'group', target), userId = this.registry.userId('group-user', openid);
    const timestamp = typeof d.timestamp === 'number' ? d.timestamp * 1000 : Date.parse(d.apply_at);
    if (!Number.isFinite(timestamp) || timestamp > this.now() + 60000 || this.now() - timestamp > 300000) return false;
    if (!this.dedup.claim(JSON.stringify([this.config.appId, payload.t, target, payload.id ?? d.join_request_id ?? `${openid}:${timestamp}`]))) return false;
    if (this.config.groupManagement) {
      await this.registry.ensureGroupState(target);
      if (!this.registry.online) return false;
    }
    const joining = payload.t === 'GROUP_JOIN_REQUEST';
    const type = payload.t === 'GROUP_MEMBER_ADD' ? 'increase' : payload.t === 'GROUP_MEMBER_REMOVE' ? 'decrease' : 'qqbot';
    const event = { bot: this.registry.account, self_id: this.registry.id, post_type: joining ? 'request' : 'notice', ...(joining ? { request_type: 'group', sub_type: 'add' } : type === 'qqbot' ? { notice_type: 'qqbot', sub_type: payload.t.toLowerCase() } : { notice_type: 'group', sub_type: type }), group_id: groupId, user_id: userId, time: Math.floor(timestamp / 1000), isGroup: true, isPrivate: false, adapter: 'QQBot', sender: { user_id: userId, nickname: typeof d.username === 'string' ? d.username.slice(0, 200) : 'QQBot 用户', role: 'member' }, ...(validOpenid(d.op_member_openid) ? { operator_id: this.registry.userId('group-user', d.op_member_openid) } : {}), qqbot: { appId: this.config.appId, scope: 'group', groupOpenid: target, userOpenid: openid, eventType: payload.t, compatibility: [], lastError: null } };
    fixMaster(event, isMaster(this.config, 'group', openid));
    this.registry.observe(this.registry.account.gl, groupId, { group_id: groupId, name: 'QQBot 群' });
    let reply;
    if (['GROUP_ADD_ROBOT', 'GROUP_MSG_RECEIVE'].includes(payload.t) && typeof payload.id === 'string' && payload.id.length <= 1024) {
      reply = new PassiveReply({ registry: this.registry, api: this.api, config: this.config, scope: 'group', target, senderId: userId, eventId: payload.id, createdAt: timestamp, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => event.qqbot.compatibility.push(code) });
      installReply(event, reply);
    }
    event.group = this.registry.contact('group', target, this.registry.account.gl.get(groupId), reply);
    event.member = event.group.pickMember(userId);
    if (joining) {
      if (typeof d.join_request_id !== 'string' || !d.join_request_id || d.join_request_id.length > 1024) throw new AdapterError('EVENT_INVALID');
      Object.assign(event, this.registry.groupRequests.observe(target, d));
    }
    const root = joining ? 'request' : 'notice';
    const category = joining ? 'group' : event.notice_type;
    const emit = () => {
      // Direct Bot.on('notice.group.increase') listeners and the host root
      // loader each receive their conventional name exactly once.
      this.registry.host.emit(`${root}.${category}.${event.sub_type}`, event);
      this.registry.host.emit(`${root}.${category}`, event);
      this.registry.host.emit(root, event);
    };
    eventContext.run({ registry: this.registry, event, reply, scope: 'group', target }, emit);
    return event;
  }
}
