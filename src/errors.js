const messages = Object.freeze({
  CONFIG_INVALID: '配置无效，请检查本地配置格式与字段范围。',
  CONFIG_PRIVATE: '私有配置不可安全读取或写入，请检查目录、文件类型及访问权限。',
  SECRET_REQUIRED: '启用前须安全配置 AppID 和 AppSecret；切换 AppID 时须重新写入密钥。',
  API_NETWORK: 'QQ 官方接口网络失败或超时，请稍后重新触发。',
  API_REJECTED: 'QQ 官方接口拒绝请求，请检查账号权限、IP 白名单、内容和额度。',
  API_RESPONSE: 'QQ 官方接口返回了无效响应。',
  PERMISSION_REQUIRED: '接口已接入，但当前机器人缺少平台权限或群内授权；请检查机器人管理员身份和群主授权。',
  MEDIA_INVALID: '媒体来源无效；支持 HTTPS URL、Buffer、base64:// 或本地普通文件，不允许读取适配器私密配置。',
  MEDIA_FORMAT: '媒体格式不支持；图片用常见图片格式，视频用 MP4，语音用 SILK、MP3、WAV 或 OGG。',
  MEDIA_TOO_LARGE: '媒体超过大小限制，请缩小文件或调整本地大小上限，官方硬上限为 200MB。',
  MEDIA_VIDEO_TOOLS: '大视频需要 FFmpeg 和 FFprobe 才能压缩为可播放视频，请先安装这两个工具；本次未按文件发送。',
  MEDIA_VIDEO_FAILED: '无法在视频大小限制内完成压缩，请缩短视频或降低清晰度后重试；本次未按文件发送。',
  MEDIA_VIDEO_TIMEOUT: '视频压缩超时，请缩短视频或降低清晰度后重试；本次未按文件发送。',
  RECALL_EXPIRED: '消息已超过两分钟撤回时限。',
  MESSAGE_UNKNOWN: '没有找到属于当前会话的消息记录，无法安全撤回或引用。',
  PARTIAL_FAILURE: '平台仅完成了部分操作，请检查状态；适配器不会自动重复执行。',
  OPERATION_INVALID: '操作参数无效，请使用当前机器人场景中的平台 ID 和文档支持的参数。',
  TARGET_DENIED: '当前会话不在适配器本地允许列表中。',
  AUTH_FAILED: 'QQ 官方鉴权失败，请在私有配置中检查凭据和平台权限。',
  GATEWAY_INVALID: 'QQ 官方网关地址或协议无效。',
  ACCOUNT_COLLISION: 'QQBot 账号注册位置已被占用，已停止启动。',
  HOST_UNSUPPORTED: '宿主事件接口不兼容，要求 Miao-Yunzai 3.1.3 的根 message 监听器。',
  OFFLINE: 'QQBot 当前离线，无法发送消息。',
  PASSIVE_ONLY: '仅支持事件内的被动回复；请使用 e.reply 或当前事件的群/好友对象。',
  REPLY_EXPIRED: '被动回复窗口已过期，请重新发送消息触发。',
  REPLY_LIMIT: '本条触发消息的回复次数已用尽，请重新触发。',
  FORWARD_INVALID: '合并内容格式不支持；可整理文字、图片和命令按钮说明。',
  FORWARD_LIMIT: '合并内容过长或层级过多，请减少条目后重新触发。',
  UNSUPPORTED_MESSAGE: '消息格式无效；支持文本、图片、语音、视频、文件、Markdown、按钮键盘、图文卡片以及适配器构建的合并内容。',
  UNSUPPORTED_OPTIONS: '回复选项无效；支持消息索引引用、at、button/keyboard、receipt 和 0–120 秒定时撤回。',
  UNSUPPORTED_API: '当前 QQ 群聊/单聊接口没有提供此调用，或旧插件使用了尚未适配的调用方式。',
  GROUP_WHOLE_MUTE_UNSUPPORTED: 'QQ 官方接口当前仅提供成员禁言写入，没有全员禁言写入字段；不能用批量禁言冒充全员禁言。',
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
