import { AsyncLocalStorage } from 'node:async_hooks';

// Event-local routing for legacy e.bot.pickGroup(...).sendMsg calls. It never
// changes Bot.uin or borrows a later user's passive reply rights.
export const eventContext = new AsyncLocalStorage();
