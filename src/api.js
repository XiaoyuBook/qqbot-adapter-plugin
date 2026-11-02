import { AdapterError } from './errors.js';

export const endpoints = Object.freeze({ token: 'https://bots.qq.com/app/getAppAccessToken', production: 'https://api.bot.qq.com', sandbox: 'https://sandbox.api.sgroup.qq.com' });
const maxResponseBytes = 1048576;

export function apiRouteAllowed(method, route) {
  if (typeof route !== 'string' || route.length > 8192) return false;
  const [pathname, query, ...extra] = route.split('?');
  if (extra.length || route.includes('#') || /[\r\n\\]/.test(route)) return false;
  if (query && method !== 'GET') return false;
  try { if (pathname.split('/').some(segment => ['.', '..'].includes(decodeURIComponent(segment)) || /[\0\r\n\\]/.test(decodeURIComponent(segment)))) return false; }
  catch { return false; }
  if (query) {
    const params = new URLSearchParams(query);
    if ([...params].some(([key, value]) => !['cursor', 'limit'].includes(key) || value.length > 2048)) return false;
  }
  if (method === 'GET' && pathname === '/gateway') return !query;
  const id = '[A-Za-z0-9_-]{1,128}';
  const opaque = '(?:[A-Za-z0-9_.:@=+-]|%[A-Fa-f0-9]{2}){1,3072}';
  if (method === 'POST' && /^\/v2\/media-images\/(prepare|complete)$/.test(pathname)) return true;
  if (method === 'GET' && pathname === '/v2/media-images') return true;
  if (method === 'DELETE' && new RegExp(`^/v2/media-images/${opaque}$`).test(pathname)) return true;
  if (method === 'POST' && new RegExp(`^/v2/(groups|users)/${id}/(messages|files|upload_prepare|upload_part_finish)$`).test(pathname)) return true;
  if (method === 'DELETE' && new RegExp(`^/v2/(groups|users)/${id}/messages/${opaque}$`).test(pathname)) return true;
  if (method === 'PUT' && new RegExp(`^/interactions/${opaque}$`).test(pathname)) return true;
  if (method === 'GET' && new RegExp(`^/v2/groups/${id}/(info|bot_state|members|members/${id}|join_request_list|restrict_chat_setting|member_blacklist)$`).test(pathname)) return true;
  return method === 'POST' && new RegExp(`^/v2/groups/${id}/(restrict_chat_setting|batch_remove_members|member_blacklist|approval_join_request/${id})$`).test(pathname);
}

export class OfficialApi {
  #secret;
  #token = null;
  #pending = null;
  #controllers = new Set();
  #closed = false;
  constructor({ config, appSecret, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.config = config;
    this.#secret = appSecret;
    this.fetch = fetchImpl;
    this.now = now;
    this.base = config.sandbox ? endpoints.sandbox : endpoints.production;
  }

  close() {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#token = null;
    this.#secret = '';
  }
  invalidateToken() { this.#token = null; }

  async #json(url, init, auth = false, allowEmpty = false) {
    if (this.#closed) throw new AdapterError('OFFLINE');
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
      // Bound parsing, and retain the timeout until the body has been consumed.
      let raw = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) { await reader.cancel(); throw new AdapterError('API_RESPONSE'); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } else {
        raw = await response.text();
        if (Buffer.byteLength(raw) > maxResponseBytes) throw new AdapterError('API_RESPONSE');
      }
      if (!raw.trim() && response.ok && allowEmpty) return {};
      let data;
      try { data = JSON.parse(raw); } catch { throw new AdapterError(response.ok ? 'API_RESPONSE' : (auth ? 'AUTH_FAILED' : 'API_REJECTED'), { status: response.status }); }
      const code = Number(data?.code ?? data?.err_code ?? 0);
      if (!response.ok || (Number.isFinite(code) && code !== 0)) {
        const retry = Number(response.headers?.get('retry-after'));
        const denied = [11282, 11253, 11254, 304036, 304037, 40062003, 40034105, 40034127].includes(code);
        throw new AdapterError(auth ? 'AUTH_FAILED' : denied ? 'PERMISSION_REQUIRED' : 'API_REJECTED', { status: response.status, platformCode: code, retryAfterMs: retry > 0 ? Math.min(retry * 1000, 300000) : undefined });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AdapterError('API_RESPONSE');
      return data;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError('API_NETWORK');
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async token() {
    if (this.#closed) throw new AdapterError('OFFLINE');
    if (this.#token && this.now() < this.#token.refreshAt) return this.#token.value;
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      const data = await this.#json(endpoints.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.config.appId, clientSecret: this.#secret })
      }, true);
      const ttl = Number(data.expires_in);
      if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(ttl) || ttl <= 0) throw new AdapterError('AUTH_FAILED');
      if (this.#closed) throw new AdapterError('OFFLINE');
      this.#token = { value: data.access_token, refreshAt: this.now() + Math.max(1, ttl - Math.min(60, ttl / 5)) * 1000 };
      return data.access_token;
    })();
    try { return await this.#pending; } finally { this.#pending = null; }
  }

  async request(method, route, body, retried = false) {
    // Only adapter-owned routes, never user supplied endpoints.
    if (!apiRouteAllowed(method, route)) throw new AdapterError('API_RESPONSE');
    const token = await this.token();
    try {
      return await this.#json(`${this.base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}`, 'X-Union-Appid': this.config.appId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }, false, ['DELETE', 'PUT'].includes(method) || /\/(upload_part_finish|restrict_chat_setting|approval_join_request\/[^/]+)$/.test(route));
    } catch (error) {
      // A 401 is a definite rejection; never retry ambiguous message POSTs/network failures.
      if (!retried && error instanceof AdapterError && error.status === 401) {
        this.invalidateToken();
        return this.request(method, route, body, true);
      }
      throw error;
    }
  }

  async gateway() { return (await this.request('GET', '/gateway')).url; }
  route(scope, target, resource) { return `/v2/${scope === 'group' ? 'groups' : 'users'}/${target}/${resource}`; }

  async uploadPart(value, bytes, contentType = 'application/octet-stream') {
    let url;
    try {
      url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !['qq.com', 'qcloud.com', 'myqcloud.com', 'tencentcos.cn'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error();
    } catch { throw new AdapterError('MEDIA_INVALID'); }
    if (!['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)) throw new AdapterError('MEDIA_INVALID');
    if (this.#closed) throw new AdapterError('OFFLINE');
    const controller = new AbortController(); this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      // Presigned URLs receive only the media bytes, never the bot token.
      const response = await this.fetch(url.href, { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType }, redirect: 'error', signal: controller.signal });
      await response.body?.cancel?.();
      if (!response.ok) throw new AdapterError('API_REJECTED', { status: response.status });
      return { etag: response.headers?.get?.('etag')?.replace(/^"|"$/g, '') };
    } catch (error) { throw error instanceof AdapterError ? error : new AdapterError('API_NETWORK'); }
    finally { clearTimeout(timer); this.#controllers.delete(controller); }
  }
}
