const messages = Object.freeze({
  CONFIG_INVALID: '配置无效，请检查本地配置格式与字段范围。',
  CONFIG_PRIVATE: '私有配置不可安全读取或写入，请检查目录、文件类型及访问权限。',
  SECRET_REQUIRED: '启用前须安全配置 AppID 和 AppSecret；切换 AppID 时须重新写入密钥。',
  API_NETWORK: 'QQ 官方接口网络失败或超时，请稍后重新触发。',
  API_REJECTED: 'QQ 官方接口拒绝请求，请检查账号权限、IP 白名单、内容和额度。',
  API_RESPONSE: 'QQ 官方接口返回了无效响应。',
  AUTH_FAILED: 'QQ 官方鉴权失败，请在私有配置中检查凭据和平台权限。',
  GATEWAY_INVALID: 'QQ 官方网关地址或协议无效。',
  ACCOUNT_COLLISION: 'QQBot 账号注册位置已被占用，已停止启动。',
  HOST_UNSUPPORTED: '宿主事件接口不兼容，要求 Miao-Yunzai 3.1.3 的根 message 监听器。',
  OFFLINE: 'QQBot 当前离线，无法发送消息。',
  PASSIVE_ONLY: '仅支持事件内的被动回复；请使用 e.reply 或当前事件的群/好友对象。',
  REPLY_EXPIRED: '被动回复窗口已过期，请重新发送消息触发。',
  REPLY_LIMIT: '本条触发消息的回复次数已用尽，请重新触发。',
  UNSUPPORTED_MESSAGE: '当前仅支持文本和图片，暂不支持语音、视频、文件、转发、按钮、Markdown 卡片或 @。',
  UNSUPPORTED_OPTIONS: '当前不支持引用对象、撤回、按钮或额外回复选项；请使用普通文本/图片回复。布尔 quote 参数仅关联被动回复，不展示引用。',
  UNSUPPORTED_API: 'QQ 官方平台或本适配器未实现此能力（群管、成员查询、头像、历史、撤回或主动发送）。',
  IMAGE_INVALID: '图片来源无效；支持 HTTPS URL、Buffer、base64:// 或本地普通图片文件。',
  IMAGE_TOO_LARGE: '图片超过适配器的单张大小限制，请缩小后重试。',
  EVENT_INVALID: 'QQBot 事件字段无效，已忽略。'
});

export class AdapterError extends Error {
  constructor(code, details = {}) {
    super(messages[code] || messages.API_RESPONSE);
    this.name = 'QQBotAdapterError';
    this.code = Object.hasOwn(messages, code) ? code : 'API_RESPONSE';
    for (const key of ['status', 'platformCode', 'retryAfterMs']) {
      if (Number.isFinite(details[key])) this[key] = details[key];
    }
  }
}

// Never carry upstream bodies, URLs, causes, credentials or chat text into logs/errors.
export function safeError(error, fallback = 'API_RESPONSE') {
  return error instanceof AdapterError ? error : new AdapterError(fallback);
}

export function logFailure(logger, label, error) {
  const safe = safeError(error);
  logger?.warn?.(`[qqbot-adapter-plugin] ${label} ${safe.code}${safe.status ? ` HTTP=${safe.status}` : ''}${safe.platformCode ? ` code=${safe.platformCode}` : ''}`);
}

export function unsupported() { throw new AdapterError('UNSUPPORTED_API'); }
