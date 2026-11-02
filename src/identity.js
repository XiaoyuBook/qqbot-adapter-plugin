import { validOpenid } from './config.js';
import { AdapterError } from './errors.js';

export function accountId(appId) { return `qqbot:${appId}`; }
export function identity(appId, kind, openid) {
  if (!['group', 'group-user', 'c2c-user'].includes(kind) || !validOpenid(openid)) throw new AdapterError('EVENT_INVALID');
  return `${accountId(appId)}:${kind}:${openid}`;
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
