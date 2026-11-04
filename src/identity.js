import { validOpenid } from './config.js';
import { AdapterError } from './errors.js';

export function accountId(appId) { return `qqbot:${appId}`; }
export function identity(appId, kind, openid) {
  if (!['group', 'group-user', 'c2c-user'].includes(kind) || !validOpenid(openid)) throw new AdapterError('EVENT_INVALID');
  return `${accountId(appId)}:${kind}:${openid}`;
}

// Only administrator-owned configuration can associate a platform principal
// with an existing data owner. Incoming QQ claims and game UIDs are never used.
export class UserIdentities {
  constructor(appId, mappings = {}) {
    this.appId = appId;
    this.mappings = new Map(); this.reverse = new Map();
    for (const [principal, qq] of Object.entries(mappings)) {
      for (const kind of ['group-user', 'c2c-user']) {
        const prefix = `${accountId(appId)}:${kind}:`;
        if (principal.startsWith(prefix)) {
          this.mappings.set(principal, qq);
          this.reverse.set(`${kind}:${qq}`, principal.slice(prefix.length));
        }
      }
    }
  }
  userId(kind, openid) {
    const principal = identity(this.appId, kind, openid);
    return this.mappings.get(principal) ?? principal;
  }
  openid(value, kind) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
    const prefix = `${accountId(this.appId)}:${kind}:`;
    if (typeof value === 'string' && value.startsWith(prefix) && validOpenid(value.slice(prefix.length))) return value.slice(prefix.length);
    const mapped = typeof value === 'string' ? this.reverse.get(`${kind}:${value}`) : undefined;
    if (!mapped) throw new AdapterError('OPERATION_INVALID');
    return mapped;
  }
}

export function isMaster(config, scope, openid) {
  return (scope === 'group' ? config.masterGroupOpenids : config.masterC2COpenids).includes(openid);
}

export function fixMaster(event, authorized) {
  Object.defineProperty(event, 'isMaster', {
    enumerable: true,
    configurable: false,
    get: () => authorized,
    // Miao's dealMsg may assign true from masterQQ. Only local OpenID grants count.
    set: () => {}
  });
}
