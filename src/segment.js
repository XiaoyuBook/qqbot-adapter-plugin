import { eventContext } from './context.js';
import { richSegment, legacyButton } from './rich.js';

const bridgeKey = Symbol.for('qqbot-adapter-plugin.segment-bridge.v1');
export function acquireSegmentBridge(registry, segment = globalThis.segment) {
  if (!segment || typeof segment !== 'object' || !Object.isExtensible(segment)) return () => {};
  let state = segment[bridgeKey];
  if (!state) {
    state = { owners: new Set(), methods: new Map() };
    for (const name of ['at', 'button', 'markdown', 'card']) {
      if (typeof segment[name] !== 'function') continue;
      const original = segment[name];
      const wrapper = function (...args) {
        const current = eventContext.getStore();
        if (current?.registry && state.owners.has(current.registry)) return name === 'button' ? legacyButton(...args) : richSegment[name](...args);
        return original.apply(this, args);
      };
      state.methods.set(name, { original, wrapper }); segment[name] = wrapper;
    }
    Object.defineProperty(segment, bridgeKey, { value: state, configurable: true });
  }
  state.owners.add(registry);
  return () => {
    state.owners.delete(registry);
    if (state.owners.size) return;
    for (const [name, method] of state.methods) if (segment[name] === method.wrapper) segment[name] = method.original;
    if (segment[bridgeKey] === state) delete segment[bridgeKey];
  };
}
