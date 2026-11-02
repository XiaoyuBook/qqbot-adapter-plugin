import { ConfigStore } from './config.js';
import { AccountRegistry } from './accounts.js';
import { OfficialApi } from './api.js';
import { GatewayTransport } from './transport.js';
import { EventDeduplicator, EventMapper } from './events.js';
import { logFailure } from './errors.js';

export class AdapterController {
  constructor({ store = new ConfigStore(), host = globalThis.Bot, logger = globalThis.logger, apiFactory = options => new OfficialApi(options), transportFactory = options => new GatewayTransport(options) } = {}) {
    Object.assign(this, { store, host, logger, apiFactory, transportFactory });
    this.active = null;
    this.queue = Promise.resolve();
    this.dedup = new Map();
    this.status = { state: 'stopped' };
  }
  #enqueue(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async #stop() {
    const active = this.active;
    this.active = null;
    active?.transport.stop();
    active?.api.close();
    active?.registry.dispose();
    this.status = { state: 'stopped' };
  }
  stop() { return this.#enqueue(() => this.#stop()); }
  start() { return this.#enqueue(async () => { if (!this.active) await this.#start(); }); }
  reload() { return this.#enqueue(async () => { await this.#stop(); await this.#start(); }); }
  async #start() {
    const { config, appSecret } = await this.store.read();
    if (!config.enabled) { this.status = { state: 'disabled' }; return; }
    const registry = new AccountRegistry(this.host, config, { logger: this.logger });
    let api;
    try {
      registry.register();
      api = this.apiFactory({ config, appSecret });
      registry.bindApi(api);
      // Preserve replay protection over configuration reloads for the same AppID.
      if (!this.dedup.has(config.appId)) this.dedup.set(config.appId, new EventDeduplicator());
      if (this.dedup.size > 10) this.dedup.delete(this.dedup.keys().next().value);
      const mapper = new EventMapper({ registry, api, config, logger: this.logger, dedup: this.dedup.get(config.appId) });
      const transport = this.transportFactory({ api, config, logger: this.logger,
        onDispatch: payload => mapper.dispatch(payload),
        onReady: data => { mapper.platformBotId = typeof data?.user?.id === 'string' ? data.user.id : null; },
        onStatus: status => {
          registry.setOnline(status.state === 'online');
          this.status = status;
          this.logger?.info?.(`[qqbot-adapter-plugin] ${status.state}${status.closeCode ? ` close=${status.closeCode}` : ''}${status.reason ? ` reason=${status.reason}` : ''}`);
        }
      });
      this.active = { registry, api, mapper, transport };
      transport.start();
    } catch (error) {
      api?.close(); registry.dispose(); throw error;
    }
  }
}

const runtimeKey = Symbol.for('qqbot-adapter-plugin.runtime.v1');
export function runtime() {
  if (!globalThis[runtimeKey]) globalThis[runtimeKey] = { store: new ConfigStore(), controller: null, shutdown: false };
  return globalThis[runtimeKey];
}
export async function startRuntime() {
  const state = runtime();
  if (!state.controller) state.controller = new AdapterController({ store: state.store });
  try { await state.controller.start(); }
  catch (error) { logFailure(globalThis.logger, 'startup', error); }
  if (!state.shutdown) {
    state.shutdown = true;
    process.once('beforeExit', () => { void state.controller.stop(); });
    // Do not install SIGINT/SIGTERM handlers: the host owns process shutdown.
    process.once('exit', () => { state.controller.active?.transport.stop(); state.controller.active?.api.close(); });
  }
}
