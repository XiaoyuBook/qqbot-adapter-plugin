import { runtime } from './controller.js';
import { pluginVersion } from './metadata.js';
import { canManageSettings, helpPanel, settingsPanel, parseSettingsCommand, settingValue, panelText } from './chat-settings.js';
import { safeError, logFailure } from './errors.js';

export async function replyPanel(event, panel) {
  const data = { ...panel, version: pluginVersion, saveId: panel.mode };
  let image;
  try {
    // Return the segment, then send once through the usual adapter reply path.
    image = await event.runtime?.render('qqbot-adapter-plugin', 'panel/index', data, { retType: 'base64' });
  } catch { globalThis.logger?.warn?.('[qqbot-adapter-plugin] panel_render_failed'); }
  if (image) {
    try {
      const result = await event.reply(image);
      if (result !== false) return true;
    } catch (error) { logFailure(globalThis.logger, 'panel_reply', error); }
  }
  // Also handles local image limits and renderer unavailability.
  await event.reply(panelText(data));
  return true;
}

export function createCommandPlugin(Plugin, { getRuntime = runtime } = {}) {
  return class QQBotCommands extends Plugin {
    constructor() {
      super({ name: 'QQBot帮助与设置', dsc: 'QQ 官方机器人适配器帮助和主人设置', event: 'message', priority: -100,
        rule: [
          { reg: /^#(?:QQBot|QQ机器人)(?:帮助|help)$/i, fnc: 'help', log: false },
          { reg: /^#(?:QQBot|QQ机器人)设置[\s\S]*$/i, fnc: 'settings', permission: 'master', log: false }
        ]
      });
    }
    async help(event) { return replyPanel(event, helpPanel()); }
    async settings(event) {
      const state = getRuntime();
      try {
        const { config } = await state.store.read();
        if (!canManageSettings(event, config)) return true;
        const command = parseSettingsCommand(event.msg);
        if (!command) return false;
        if (command.type === 'view') return await replyPanel(event, settingsPanel(config, state.controller?.status));
        if (command.type === 'invalid') { await event.reply(command.message); return true; }
        if (!state.controller) { await event.reply('适配器运行时尚未初始化，请稍后重试。'); return true; }
        await state.controller.configure(command.patch, {
          authorize: current => canManageSettings(event, current),
          acknowledge: (saved, changed) => event.reply(command.item.name + '：' + settingValue(command.item, saved[command.item.key]) + (changed ? '。已保存，正在重新加载连接；短暂离线后可发送 #QQBot设置 查看状态。' : '。当前已是该设置，无需重新加载。'))
        });
      } catch (error) {
        logFailure(globalThis.logger, 'settings', error);
        await event.reply(safeError(error, 'CONFIG_INVALID').message);
      }
      return true;
    }
  };
}
