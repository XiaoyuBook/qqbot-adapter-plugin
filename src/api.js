import { AdapterError } from './errors.js';

export const endpoints = Object.freeze({ token: 'https://bots.qq.com/app/getAppAccessToken', production: 'https://api.sgroup.qq.com', sandbox: 'https://sandbox.api.sgroup.qq.com' });
const maxResponseBytes = 1048576;

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

  async #json(url, init, auth = false) {
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
      let data;
      try { data = JSON.parse(raw); } catch { throw new AdapterError(response.ok ? 'API_RESPONSE' : (auth ? 'AUTH_FAILED' : 'API_REJECTED'), { status: response.status }); }
      const code = Number(data?.code ?? data?.err_code ?? 0);
      if (!response.ok || (Number.isFinite(code) && code !== 0)) {
        const retry = Number(response.headers?.get('retry-after'));
        throw new AdapterError(auth ? 'AUTH_FAILED' : 'API_REJECTED', { status: response.status, platformCode: code, retryAfterMs: retry > 0 ? Math.min(retry * 1000, 300000) : undefined });
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
    if (!/^\/(gateway|v2\/(groups|users)\/[A-Za-z0-9_-]{1,128}\/(messages|files))$/.test(route)) throw new AdapterError('API_RESPONSE');
    const token = await this.token();
    try {
      return await this.#json(`${this.base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}`, 'X-Union-Appid': this.config.appId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
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
}
