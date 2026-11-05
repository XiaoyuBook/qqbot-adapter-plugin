import { startRuntime } from './src/controller.js';
import { createCommandPlugin } from './src/commands.js';

// The Miao loader instantiates every exported function with a prototype.
// Expose only real lifecycle/command plugins, never account or transport classes.
class QQBotAdapterBootstrap {
  constructor() { this.name = 'qqbot-adapter-plugin'; }
  async init() {
    await startRuntime();
    return 'return';
  }
}
const QQBotCommands = createCommandPlugin(globalThis.plugin);
export const apps = { QQBotAdapterBootstrap, QQBotCommands };
