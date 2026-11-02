import { startRuntime } from './src/controller.js';

// The Miao loader instantiates every exported function with a prototype.
// Export only the lifecycle plugin, never transport/account utility classes.
class QQBotAdapterBootstrap {
  constructor() { this.name = 'qqbot-adapter-plugin'; }
  async init() {
    await startRuntime();
    return 'return';
  }
}
export const apps = { QQBotAdapterBootstrap };
