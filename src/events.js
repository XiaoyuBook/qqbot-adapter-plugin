import { validOpenid } from './config.js';
import { identity, fixMaster, isMaster } from './identity.js';
import { PassiveReply, installReply } from './reply.js';
import { AdapterError } from './errors.js';
import { eventContext } from './context.js';
import { role } from './group.js';
import { richSegment } from './rich.js';

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
    const principalId = identity(this.config.appId, scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const userId = this.registry.userId(scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const groupId = scope === 'group' ? identity(this.config.appId, 'group', target) : undefined;
    let content = d.content || '';
    if (scope === 'group') {
      // Only a leading mention of the READY identity may be removed.
      if (this.platformBotId && /^[A-Za-z0-9_-]+$/.test(this.platformBotId)) content = content.replace(new RegExp(`^\\s*<@!?${this.platformBotId}>\\s*`), '');
      content = content.trimStart();
    }
    const nickname = typeof d.author.username === 'string' && d.author.username.length <= 200 ? d.author.username : 'QQBot 用户';
    const sender = { user_id: userId, nickname, card: nickname, role: role(d.author.member_role) };
    const atBot = payload.t === 'GROUP_AT_MESSAGE_CREATE';
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
      qqbot: { appId: this.config.appId, scope, principalId, userOpenid: openid, ...(scope === 'group' ? { groupOpenid: target } : {}), eventId: typeof payload.id === 'string' ? payload.id : undefined, referenceId, unsupportedAttachments: [], compatibility: [], lastError: null, segment: richSegment }
    };
    if (atBot) event.message.push({ type: 'at', qq: this.registry.id, text: 'QQ 官方机器人' });
    if (scope === 'group' && Array.isArray(d.mentions)) {
      if (d.mentions.length > 100) throw new AdapterError('EVENT_INVALID');
      for (const mention of d.mentions) {
        const id = mention?.member_openid ?? mention?.id;
        if (validOpenid(id) && !mention.bot) event.message.push({ type: 'at', qq: this.registry.userId('group-user', id), text: typeof mention.username === 'string' ? mention.username.slice(0, 200) : '' });
      }
    }
    if (content) event.message.push({ type: 'text', text: content });
    for (const attachment of d.attachments || []) {
      const kind = attachment && (/^image\/(png|jpeg|gif|webp|bmp)$/.test(attachment.content_type) ? 'image' : attachment.content_type === 'voice' || /^audio\//.test(attachment.content_type) ? 'record' : attachment.content_type === 'video/mp4' ? 'video' : attachment.content_type === 'file' || attachment.content_type === 'application/octet-stream' ? 'file' : null);
      if (kind && typeof attachment.url === 'string') {
        let url;
        try { url = new URL(attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url); }
        catch { throw new AdapterError('EVENT_INVALID'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new AdapterError('EVENT_INVALID');
        event.message.push({ type: kind, url: url.href, file: url.href, ...(typeof attachment.filename === 'string' ? { name: attachment.filename.slice(0, 255) } : {}), ...(Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? { size: attachment.size } : {}), ...(kind === 'record' && typeof attachment.asr_refer_text === 'string' ? { asr: attachment.asr_refer_text.slice(0, 64000) } : {}) });
      } else event.qqbot.unsupportedAttachments.push('unsupported');
    }
    fixMaster(event, isMaster(this.config, scope, openid));
    if (sourceReference) event.source = { message_id: sourceReference, ref_idx: sourceReference, message: [] };
    this.registry.rememberMessage(scope, target, d.id, { own: false, at: timestamp, ref_idx: referenceId });
    const reply = new PassiveReply({ registry: this.registry, api: this.api, config: this.config, scope, target, senderId: userId, messageId: d.id, referenceId, createdAt, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => { if (!event.qqbot.compatibility.includes(code)) event.qqbot.compatibility.push(code); } });
    installReply(event, reply);
    const rejectUnsupported = () => {
      const error = new AdapterError('UNSUPPORTED_API');
      void reply.fail(error);
      throw error;
    };
    const userInfo = { user_id: userId, nickname: sender.nickname, card: sender.card, role: sender.role };
    if (scope === 'group') {
      this.registry.observeMember(groupId, userId, { ...userInfo, is_admin: ['admin', 'owner'].includes(sender.role), is_owner: sender.role === 'owner' });
      const group = this.registry.contact(scope, target, this.registry.account.gl.get(groupId) ?? { group_id: groupId, name: 'QQBot 群', group_name: 'QQBot 群', mute_left: 0 }, reply, rejectUnsupported);
      const member = group.pickMember(userId);
      event.group = group;
      event.member = member;
      this.registry.observe(this.registry.account.gl, groupId, group.info);
    } else {
      event.friend = this.registry.contact(scope, target, userInfo, reply, rejectUnsupported);
      this.registry.observe(this.registry.account.fl, userId, userInfo);
    }
    if (!content && !event.message.some(part => ['image', 'video', 'record', 'file'].includes(part.type)) && event.qqbot.unsupportedAttachments.length) {
      await reply.fail(new AdapterError('UNSUPPORTED_MESSAGE'));
      return false;
    }
    // ICQQ TripTrap emits only the named root. Never also emit message.group or
    // call PluginsLoader.deal: either would run the same business handler twice.
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
    const joining = payload.t === 'GROUP_JOIN_REQUEST';
    const type = payload.t === 'GROUP_MEMBER_ADD' ? 'increase' : payload.t === 'GROUP_MEMBER_REMOVE' ? 'decrease' : 'qqbot';
    const event = { bot: this.registry.account, self_id: this.registry.id, post_type: joining ? 'request' : 'notice', ...(joining ? { request_type: 'group', sub_type: 'add' } : { notice_type: type, sub_type: payload.t.toLowerCase() }), group_id: groupId, user_id: userId, time: Math.floor(timestamp / 1000), isGroup: true, isPrivate: false, adapter: 'QQBot', qqbot: { appId: this.config.appId, scope: 'group', groupOpenid: target, userOpenid: openid, eventType: payload.t, compatibility: [], lastError: null } };
    fixMaster(event, isMaster(this.config, 'group', openid));
    this.registry.observe(this.registry.account.gl, groupId, { group_id: groupId, name: 'QQBot 群' });
    let reply;
    if (['GROUP_ADD_ROBOT', 'GROUP_MSG_RECEIVE'].includes(payload.t) && typeof payload.id === 'string' && payload.id.length <= 1024) {
      reply = new PassiveReply({ registry: this.registry, api: this.api, config: this.config, scope: 'group', target, senderId: userId, eventId: payload.id, createdAt: timestamp, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => event.qqbot.compatibility.push(code) });
      installReply(event, reply);
    }
    event.group = this.registry.contact('group', target, this.registry.account.gl.get(groupId), reply);
    if (joining) {
      if (typeof d.join_request_id !== 'string' || !d.join_request_id || d.join_request_id.length > 1024) throw new AdapterError('EVENT_INVALID');
      event.flag = d.join_request_id;
      event.comment = typeof d.verify_info?.verify_message === 'string' ? d.verify_info.verify_message.slice(0, 4000) : '';
      event.approve = (approve = true, reason = '') => this.registry.group(target).approveJoinRequest(userId, d.join_request_id, approve, reason);
    }
    const emit = () => this.registry.host.emit(joining ? 'request' : 'notice', event);
    if (reply) eventContext.run({ registry: this.registry, event, reply, scope: 'group', target }, emit);
    else emit();
    return event;
  }
}
