import { runtime } from './src/controller.js';
import { safeError } from './src/errors.js';

export function createGuobaSupport({ store, reload = async () => {} }) {
  const listFields = ['masterGroupOpenids', 'masterC2COpenids', 'allowedGroupOpenids', 'allowedC2COpenids'];
  return {
    pluginInfo: { name: 'qqbot-adapter-plugin', title: 'QQ 官方机器人适配器', description: 'Miao-Yunzai 3.1.3 群 @ / C2C 被动回复；WebSocket 向外连接', link: 'https://github.com/XiaoyuBook/qqbot-adapter-plugin', isV3: true, isV2: false, showInMenu: true, icon: 'mdi:robot' },
    configInfo: {
      schemas: [
        { field: 'enabled', label: '启用连接', component: 'Switch' },
        { field: 'appId', label: 'AppID', component: 'Input', bottomHelpMessage: '切换 AppID 时必须重新输入 AppSecret。' },
        { field: 'appSecret', label: '写入 AppSecret', component: 'InputPassword', componentProps: { autocomplete: 'new-password' }, bottomHelpMessage: '只写入，不回显。留空保留旧密钥。仅在可信的锅巴 HTTPS/SSH 隧道中使用；保存后会重新连接。' },
        { field: 'secretConfigured', label: '已配置密钥', component: 'Switch', componentProps: { disabled: true } },
        { field: 'sandbox', label: '沙箱 API', component: 'Switch', bottomHelpMessage: '沙箱场景是否可用由 QQ 平台决定，仍需账号实测。' },
        { field: 'receiveGroup', label: '接收群 @', component: 'Switch' },
        { field: 'receiveC2C', label: '接收 C2C', component: 'Switch' },
        ...listFields.map(field => ({ field, label: ({ masterGroupOpenids: '授权主人 member_openid（群）', masterC2COpenids: '授权主人 user_openid（C2C）', allowedGroupOpenids: '允许的 group_openid', allowedC2COpenids: '允许的 user_openid' })[field], component: 'InputTextArea', bottomHelpMessage: '每行一个原始 OpenID；两个场景分别配置。空白名单允许全部，空主人列表不授权任何人。' })),
        { field: 'replyWindowSeconds', label: '被动回复窗口（秒）', component: 'InputNumber', componentProps: { min: 1, max: 240 } },
        { field: 'maxReplies', label: '每条触发最大回复数', component: 'InputNumber', componentProps: { min: 1, max: 5 } },
        { field: 'requestTimeoutMs', label: '请求超时（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 120000 } },
        { field: 'reconnectMinMs', label: '最短重连间隔（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 60000 } },
        { field: 'reconnectMaxMs', label: '最长重连间隔（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 300000 } },
        { field: 'maxImageBytes', label: '单张图片上限（字节）', component: 'InputNumber', componentProps: { min: 1, max: 4194304 } }
      ],
      async getConfigData() {
        const data = await store.publicData();
        for (const field of listFields) data[field] = data[field].join('\n');
        return data;
      },
      async setConfigData(input, { Result }) {
        try {
          const patch = { ...input };
          for (const field of listFields) {
            if (typeof patch[field] === 'string') patch[field] = patch[field].split(/\r?\n/).map(value => value.trim()).filter(Boolean);
          }
          await store.save(patch);
          try { await reload(); }
          catch { return Result.ok({}, '已私有保存，运行时重新加载失败，请检查状态并在维护窗口重启喵崽。'); }
          // Never return submitted fields (Guoba may serialize this result).
          return Result.ok({}, '已私有保存并应用；连接状态与真实收发需另行确认。');
        } catch (error) {
          return Result.error(safeError(error, 'CONFIG_INVALID').message);
        }
      }
    }
  };
}

export function supportGuoba() {
  const state = runtime();
  return createGuobaSupport({ store: state.store, reload: () => state.controller?.reload() });
}
