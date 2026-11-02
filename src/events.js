import { validOpenid } from './config.js';
import { identity, fixMaster, isMaster } from './identity.js';
import { contact } from './accounts.js';
import { PassiveReply, installReply } from './reply.js';
import { AdapterError, unsupported } from './errors.js';

export class EventDeduplicator {
  constructor({ now = Date.now, ttlMs = 600000, max = 20000 } = {}) { Object.assign(this, { now, ttlMs, max }); this.seen = new Map(); }
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
    this.platformBotId = null;
  }
  async dispatch(payload) {
    const scope = payload.t === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : payload.t === 'C2C_MESSAGE_CREATE' ? 'c2c' : null;
    if (!scope || !this.registry.online || !(scope === 'group' ? this.config.receiveGroup : this.config.receiveC2C)) return false;
    const d = payload.d;
    const openid = scope === 'group' ? d?.author?.member_openid : d?.author?.user_openid;
    const target = scope === 'group' ? d?.group_openid : openid;
    if (!validOpenid(openid) || !validOpenid(target) || typeof d?.id !== 'string' || !d.id || d.id.length > 512 || (d.content !== undefined && (typeof d.content !== 'string' || d.content.length > 64000)) || (d.attachments !== undefined && (!Array.isArray(d.attachments) || d.attachments.length > 10))) throw new AdapterError('EVENT_INVALID');
    const allowed = scope === 'group' ? this.config.allowedGroupOpenids : this.config.allowedC2COpenids;
    if (allowed.length && !allowed.includes(target)) return false;
    const timestamp = Date.parse(d.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > this.now() + 60000) throw new AdapterError('EVENT_INVALID');
    // Never turn an old replay into a fresh passive send window.
    const createdAt = Math.min(this.now(), timestamp);
    if (this.now() - createdAt > this.config.replyWindowSeconds * 1000) return false;
    const key = JSON.stringify([this.config.appId, scope, target, d.id]);
    if (!this.dedup.claim(key)) return false;
    const userId = identity(this.config.appId, scope === 'group' ? 'group-user' : 'c2c-user', openid);
    const groupId = scope === 'group' ? identity(this.config.appId, 'group', target) : undefined;
    let content = d.content || '';
    if (scope === 'group') {
      // Only a leading mention of the READY identity may be removed.
      if (this.platformBotId && /^[A-Za-z0-9_-]+$/.test(this.platformBotId)) content = content.replace(new RegExp(`^\\s*<@!?${this.platformBotId}>\\s*`), '');
      content = content.trimStart();
    }
    const sender = { user_id: userId, nickname: 'QQBot 用户', card: 'QQBot 用户', role: 'member' };
    const event = {
      bot: this.registry.account,
      self_id: this.registry.id, post_type: 'message', message_type: scope === 'group' ? 'group' : 'private',
      sub_type: scope === 'group' ? 'normal' : 'friend',
      user_id: userId, ...(groupId ? { group_id: groupId, group_name: 'QQBot 群' } : {}),
      message_id: d.id, time: Math.floor(timestamp / 1000), raw_message: content,
      sender, message: [], adapter: 'QQBot',
      isGroup: scope === 'group', isPrivate: scope === 'c2c', atBot: scope === 'group',
      qqbot: { appId: this.config.appId, scope, userOpenid: openid, ...(scope === 'group' ? { groupOpenid: target } : {}), eventId: typeof payload.id === 'string' ? payload.id : undefined, unsupportedAttachments: [], compatibility: [], lastError: null },
      getAvatarUrl: unsupported
    };
    if (scope === 'group') event.message.push({ type: 'at', qq: this.registry.id, text: 'QQ 官方机器人' });
    if (content) event.message.push({ type: 'text', text: content });
    for (const attachment of d.attachments || []) {
      if (attachment && /^image\/(png|jpeg|gif|webp)$/.test(attachment.content_type) && typeof attachment.url === 'string') {
        let url;
        try { url = new URL(attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url); }
        catch { throw new AdapterError('EVENT_INVALID'); }
        if (url.protocol !== 'https:' || url.username || url.password) throw new AdapterError('EVENT_INVALID');
        event.message.push({ type: 'image', url: url.href, file: url.href });
      } else event.qqbot.unsupportedAttachments.push('unsupported');
    }
    fixMaster(event, isMaster(this.config, scope, openid));
    const reply = new PassiveReply({ api: this.api, config: this.config, scope, target, senderId: userId, messageId: d.id, createdAt, online: () => this.registry.online, logger: this.logger, now: this.now, onError: error => { event.qqbot.lastError = error; }, onCompatibility: code => { if (!event.qqbot.compatibility.includes(code)) event.qqbot.compatibility.push(code); } });
    installReply(event, reply);
    const rejectUnsupported = () => {
      const error = new AdapterError('UNSUPPORTED_API');
      void reply.fail(error);
      throw error;
    };
    event.getAvatarUrl = rejectUnsupported;
    const userInfo = { user_id: userId, nickname: sender.nickname, card: sender.card, role: 'member' };
    if (scope === 'group') {
      const member = contact({ ...userInfo, is_admin: false, is_owner: false, _info: userInfo }, undefined, rejectUnsupported);
      const group = contact({ group_id: groupId, name: 'QQBot 群', group_name: 'QQBot 群', mute_left: 0 }, (...args) => reply.send(...args), rejectUnsupported);
      group.pickMember = id => { if (id !== userId) return unsupported(); return member; };
      event.group = group;
      event.member = member;
      group.recallMsg = () => reply.fail(new AdapterError('UNSUPPORTED_API'), false);
      this.registry.observe(this.registry.account.gl, groupId, group.info);
    } else {
      event.friend = contact(userInfo, (...args) => reply.send(...args), rejectUnsupported);
      // Legacy QR helpers call recall from an unawaited timer. Report false and
      // diagnostics without throwing from that timer, claiming a deletion, or
      // consuming another reply slot from a login flow's limited passive quota.
      event.friend.recallMsg = () => reply.fail(new AdapterError('UNSUPPORTED_API'), false);
      this.registry.observe(this.registry.account.fl, userId, userInfo);
    }
    if (!content && !event.message.some(part => part.type === 'image') && event.qqbot.unsupportedAttachments.length) {
      await reply.fail(new AdapterError('UNSUPPORTED_MESSAGE'));
      return false;
    }
    // ICQQ TripTrap emits only the named root. Never also emit message.group or
    // call PluginsLoader.deal: either would run the same business handler twice.
    this.registry.host.emit('message', event);
    return event;
  }
}
