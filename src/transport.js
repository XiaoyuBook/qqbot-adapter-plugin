import WebSocket from 'ws';
import { AdapterError, logFailure } from './errors.js';

const fatalCodes = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
const gatewayHosts = new Set(['api.sgroup.qq.com', 'sandbox.api.sgroup.qq.com', 'api.bot.qq.com', 'sandbox.api.bot.qq.com']);

export function validateGateway(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || !gatewayHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error();
    return url.href;
  } catch { throw new AdapterError('GATEWAY_INVALID'); }
}

// Outbound-only, one socket owner, ACK watchdog, bounded backoff, RAM-only RESUME.
export class GatewayTransport {
  constructor({ api, config, onDispatch, onStatus = () => {}, onReady = () => {}, logger, socketFactory = (url, options) => new WebSocket(url, options), timers = globalThis, random = Math.random, now = Date.now }) {
    Object.assign(this, { api, config, onDispatch, onStatus, onReady, logger, socketFactory, timers, random, now });
    this.state = 'stopped';
    this.socket = null;
    this.sessionId = null;
    this.sequence = null;
    this.running = false;
    this.generation = 0;
    this.attempt = 0;
    this.readyAt = null;
    this.pendingAck = false;
    this.ackCount = 0;
    this.handles = new Map();
  }

  #timer(name, delay, callback) {
    this.#clear(name);
    const handle = this.timers.setTimeout(() => { this.handles.delete(name); callback(); }, delay);
    this.handles.set(name, handle);
  }
  #clear(name) {
    if (this.handles.has(name)) this.timers.clearTimeout(this.handles.get(name));
    this.handles.delete(name);
  }
  #status(state, code, reason) {
    this.state = state;
    try { this.onStatus({ state, ...(Number.isInteger(code) ? { closeCode: code } : {}), ...(reason ? { reason } : {}) }); }
    catch (error) { logFailure(this.logger, 'status_callback', error); }
  }
  #retire() {
    for (const name of [...this.handles.keys()]) this.#clear(name);
    const socket = this.socket;
    this.socket = null;
    this.pendingAck = false;
    // Keep an error handler installed: late errors from retired ws must be harmless.
    try { socket?.terminate(); } catch {}
  }
  #resetSession() { this.sessionId = null; this.sequence = null; }

  start() {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    void this.#connect();
  }
  stop() {
    this.running = false;
    this.generation++;
    this.#retire();
    this.#resetSession();
    this.#status('stopped');
  }

  #retry({ code, reset = false, fatal = false, delay = 0, reason = 'connection_lost' } = {}) {
    if (!this.running) return;
    if (this.readyAt !== null && this.now() - this.readyAt >= 30000) this.attempt = 0;
    this.readyAt = null;
    this.generation++;
    this.#retire();
    if (reset) this.#resetSession();
    if (fatal) { this.running = false; this.#status('blocked', code, reason); return; }
    this.#status('reconnecting', code, reason);
    const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 20));
    const backoff = Math.max(delay, Math.min(this.config.reconnectMaxMs, Math.round(base * (0.75 + this.random() * 0.5))));
    this.#timer('retry', backoff, () => void this.#connect());
  }

  async #connect() {
    if (!this.running) return;
    const generation = ++this.generation;
    this.#status('connecting');
    try {
      const token = await this.api.token();
      if (!this.running || generation !== this.generation) return;
      const url = validateGateway(await this.api.gateway());
      if (!this.running || generation !== this.generation) return;
      const ws = this.socketFactory(url, { handshakeTimeout: this.config.requestTimeoutMs, maxPayload: 1048576, perMessageDeflate: false, followRedirects: false });
      this.socket = ws;
      const current = () => this.running && generation === this.generation && this.socket === ws;
      let hello = false;
      this.ackCount = 0;
      this.#timer('handshake', this.config.requestTimeoutMs, () => { if (current()) this.#retry({ reason: 'hello_timeout' }); });
      ws.on('message', raw => {
        if (!current()) return;
        try {
          const payload = JSON.parse(raw.toString());
          if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.op)) throw new AdapterError('GATEWAY_INVALID');
          if (Number.isSafeInteger(payload.s) && payload.s >= 0) this.sequence = payload.s;
          switch (payload.op) {
            case 10: {
              const interval = payload.d?.heartbeat_interval;
              if (hello || !Number.isFinite(interval) || interval < 100 || interval > 300000) throw new AdapterError('GATEWAY_INVALID');
              hello = true;
              this.#clear('handshake');
              this.#timer('identify', this.config.requestTimeoutMs, () => { if (current()) this.#retry({ reason: 'ready_timeout' }); });
              if (this.sessionId && this.sequence !== null) this.#send({ op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence } });
              else this.#send({ op: 2, d: { token: `QQBot ${token}`, intents: (1 << 25) | (1 << 26) | (this.config.receiveGroupNotices ? 1 << 24 : 0), shard: [0, 1], properties: { $os: process.platform, $browser: 'qqbot-adapter-plugin', $device: 'qqbot-adapter-plugin' } } });
              const beat = () => {
                if (!current()) return;
                if (this.pendingAck) { this.#retry({ reason: 'heartbeat_timeout' }); return; }
                if (this.state !== 'online') { this.#timer('heartbeat', interval, beat); return; }
                this.#heartbeat();
                this.#timer('heartbeat', interval, beat);
              };
              // Match the official lifecycle: authenticate first, then send at
              // the negotiated cadence. A pre-READY heartbeat can be ignored by
              // the gateway and must not arm an ACK timeout for the first tick.
              this.#timer('heartbeat', interval, beat);
              break;
            }
            case 11:
              if (this.pendingAck) {
                this.pendingAck = false;
                if (++this.ackCount === 1) this.logger?.info?.('[qqbot-adapter-plugin] heartbeat_ack');
              }
              break;
            case 1: if (this.state === 'online') this.#heartbeat(); break;
            case 7: this.#retry({ reason: 'server_reconnect' }); break;
            case 9: this.#retry({ reset: payload.d !== true, delay: 3000, reason: 'invalid_session' }); break;
            case 0: {
              if (!hello) throw new AdapterError('GATEWAY_INVALID');
              if (payload.t === 'READY') {
                if (typeof payload.d?.session_id !== 'string' || !payload.d.session_id) throw new AdapterError('GATEWAY_INVALID');
                this.sessionId = payload.d.session_id;
                this.onReady(payload.d);
                this.#clear('identify');
                this.readyAt = this.now();
                this.#status('online');
              } else if (payload.t === 'RESUMED') {
                this.#clear('identify');
                this.readyAt = this.now();
                this.#status('online');
              } else if (this.state === 'online') {
                Promise.resolve(this.onDispatch(payload)).catch(error => logFailure(this.logger, 'dispatch', error));
              }
              break;
            }
          }
        } catch (error) {
          logFailure(this.logger, 'gateway_frame', error);
          this.#retry({ reset: true, reason: 'invalid_frame' });
        }
      });
      ws.on('close', code => {
        if (!current()) return;
        if (code === 4004) this.api.invalidateToken();
        this.#retry({ code, reason: 'socket_closed', fatal: fatalCodes.has(code), reset: [4004, 4006, 4007].includes(code) || (code >= 4900 && code <= 4913), delay: [4004, 4008].includes(code) ? 60000 : 0 });
      });
      ws.on('error', () => { if (current()) this.#retry({ reason: 'socket_error' }); });
    } catch (error) {
      if (!this.running || generation !== this.generation) return;
      logFailure(this.logger, 'connect', error);
      this.#retry({ reason: 'connect_failed', fatal: ['GATEWAY_INVALID'].includes(error.code) || [401, 403].includes(error.status), delay: error.retryAfterMs || 0 });
    }
  }

  #send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new AdapterError('OFFLINE');
    this.socket.send(JSON.stringify(payload));
  }
  #heartbeat() {
    this.pendingAck = true;
    try { this.#send({ op: 1, d: this.sequence }); }
    catch (error) { this.pendingAck = false; throw error; }
  }
}
