import { runtime } from './src/controller.js';
import { safeError } from './src/errors.js';

export function createGuobaSupport({ store, reload = async () => {} }) {
  const listFields = ['masterGroupOpenids', 'masterC2COpenids', 'allowedGroupOpenids', 'allowedC2COpenids'];
  return {
    pluginInfo: { name: 'qqbot-adapter-plugin', title: 'QQ 官方机器人适配器', description: '群聊 / 单聊图文、语音、视频、文件、Markdown、按钮、引用撤回与群管理；WebSocket 向外连接', link: 'https://github.com/XiaoyuBook/qqbot-adapter-plugin', isV3: true, isV2: false, showInMenu: true, icon: 'mdi:robot' },
    configInfo: {
      schemas: [
        { field: 'enabled', label: '启用连接', component: 'Switch' },
        { field: 'appId', label: 'AppID', component: 'Input', bottomHelpMessage: '切换 AppID 时必须重新输入 AppSecret。' },
        { field: 'appSecret', label: '写入 AppSecret', component: 'InputPassword', componentProps: { autocomplete: 'new-password' }, bottomHelpMessage: '只写入，不回显。留空保留旧密钥。仅在可信的锅巴 HTTPS/SSH 隧道中使用；保存后会重新连接。' },
        { field: 'secretConfigured', label: '已配置密钥', component: 'Switch', componentProps: { disabled: true } },
        { field: 'sandbox', label: '沙箱 API', component: 'Switch', bottomHelpMessage: '沙箱场景是否可用由 QQ 平台决定，仍需账号实测。' },
        { field: 'receiveGroup', label: '接收群 @', component: 'Switch' },
        { field: 'receiveC2C', label: '接收 C2C', component: 'Switch' },
        { field: 'receiveGroupMessages', label: '接收非 @ 群消息', component: 'Switch', bottomHelpMessage: '须在 QQ 群内授权机器人接收全量消息；仍会遵循喵崽的群消息触发设置。' },
        { field: 'receiveGroupNotices', label: '接收入群申请和成员变动', component: 'Switch', bottomHelpMessage: '入群申请事件要求机器人是管理员；处理申请由已安装的业务插件决定。' },
        { field: 'allowProactive', label: '允许插件主动发送', component: 'Switch', bottomHelpMessage: '开启后允许插件定时或跨会话发送到已知联系人；仍受平台授权和频率限制。事件内回复不需要开启。' },
        { field: 'mentionBeforeImage', label: '群图片：上方 @，下方图片', component: 'Switch', bottomHelpMessage: '同一条消息内排版；私聊不自动 @。关闭后使用普通图片消息。' },
        ...listFields.map(field => ({ field, label: ({ masterGroupOpenids: '授权主人 member_openid（群）', masterC2COpenids: '授权主人 user_openid（C2C）', allowedGroupOpenids: '允许的 group_openid', allowedC2COpenids: '允许的 user_openid' })[field], component: 'InputTextArea', bottomHelpMessage: '每行一个原始 OpenID；两个场景分别配置。空白名单允许全部，空主人列表不授权任何人。' })),
        { field: 'replyWindowSeconds', label: '被动回复窗口（秒）', component: 'InputNumber', componentProps: { min: 1, max: 300 } },
        { field: 'c2cReplyWindowSeconds', label: '单聊被动回复窗口（秒）', component: 'InputNumber', componentProps: { min: 1, max: 3600 } },
        { field: 'maxReplies', label: '每条触发最大回复数', component: 'InputNumber', componentProps: { min: 1, max: 5 } },
        { field: 'requestTimeoutMs', label: '请求超时（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 120000 } },
        { field: 'reconnectMinMs', label: '最短重连间隔（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 60000 } },
        { field: 'reconnectMaxMs', label: '最长重连间隔（毫秒）', component: 'InputNumber', componentProps: { min: 1000, max: 300000 } },
        { field: 'maxImageBytes', label: '单张图片上限（字节）', component: 'InputNumber', componentProps: { min: 1, max: 209715200 } },
        { field: 'maxMediaBytes', label: '语音/视频/文件上限（字节）', component: 'InputNumber', componentProps: { min: 1, max: 209715200 } }
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
