import { defaults } from './config.js';
import { isMaster } from './identity.js';

const MiB = 1024 * 1024;
export const chatSettings = Object.freeze([
  { key: 'receiveGroupMessages', name: '免艾特', aliases: ['免@'], note: '还需 QQ 群允许接收全部消息，以及宿主对应群 onlyReplyAt=0。' },
  { key: 'mentionBeforeImage', name: '图片艾特', aliases: ['图片@'], note: '群聊同条消息上方 @、下方图片；私聊不自动 @。' },
  { key: 'receiveGroupNotices', name: '群通知', note: '接收入群申请和成员变动；仍受官方授权限制。' },
  { key: 'groupManagement', name: '群管兼容', note: '查询真实群角色；群管功能还需平台与群内授权。' },
  { key: 'allowProactive', name: '主动消息', note: '允许向已知联系人主动发送；仍受平台额度限制。' },
  { key: 'replyWindowSeconds', name: '群回复窗口', unit: '秒', min: 1, max: 300, factor: 1 },
  { key: 'c2cReplyWindowSeconds', name: '私聊回复窗口', unit: '秒', min: 1, max: 3600, factor: 1 },
  { key: 'maxReplies', name: '回复次数', unit: '次', min: 1, max: 5, factor: 1, note: '每条触发的本地上限；C2C 另受最多 4 次限制。' },
  { key: 'requestTimeoutMs', name: '请求超时', unit: '秒', min: 1, max: 120, factor: 1000 },
  { key: 'maxImageBytes', name: '图片上限', unit: 'MiB', min: 1, max: 200, factor: MiB, note: '本地大小上限；同条 @ 图片还受素材 10 MiB 限制。' },
  { key: 'maxMediaBytes', name: '媒体上限', unit: 'MiB', min: 1, max: 200, factor: MiB, note: '本地语音、视频、文件上限；平台仍可能另有限制。' }
].map(item => Object.freeze(item)));

export function canManageSettings(event, config) {
  if (event?.isMaster !== true) return false;
  if (event.adapter === 'QQBot' || event.qqbot) {
    const q = event.qqbot;
    return event.adapter === 'QQBot' && q?.appId === config.appId && ['group', 'c2c'].includes(q.scope) && isMaster(config, q.scope, q.userOpenid);
  }
  return true;
}

export function settingValue(item, value) {
  if (!item.factor) return value ? '开启' : '关闭';
  const number = value / item.factor;
  return (Number.isInteger(number) ? String(number) : String(Number(number.toFixed(6)))) + ' ' + item.unit;
}

export function parseSettingsCommand(message) {
  const match = /^#(?:QQBot|QQ机器人)设置([\s\S]*)$/i.exec(String(message).trim());
  if (!match) return null;
  const input = match[1].trim();
  if (!input) return { type: 'view' };
  for (const item of chatSettings) {
    const name = [item.name, ...(item.aliases || [])].find(name => input.startsWith(name));
    if (!name) continue;
    const value = input.slice(name.length).trim();
    const hint = item.factor ? item.name + '：输入 ' + item.min + '–' + item.max + ' 的整数（' + item.unit + '），或「默认」。' : item.name + '：输入「开启」「关闭」或「默认」。';
    let next;
    if (value === '默认') next = defaults[item.key];
    else if (!item.factor && ['开启', '关闭'].includes(value)) next = value === '开启';
    else {
      const number = /^\d+$/.test(value) ? Number(value) : NaN;
      if (Number.isSafeInteger(number) && number >= item.min && number <= item.max) next = number * item.factor;
    }
    return next === undefined ? { type: 'invalid', message: hint } : { type: 'set', item, patch: { [item.key]: next } };
  }
  return { type: 'invalid', message: '请发送 #QQBot设置 查看可用项目。用法：#QQBot设置免艾特开启；单项恢复：#QQBot设置免艾特默认。密钥、主人授权、身份映射等请在锅巴管理中配置。' };
}

const states = { online: '已连接', connecting: '连接中', reconnecting: '重连中', blocked: '连接受限', stopped: '已停止', disabled: '未启用', error: '应用配置失败' };
export function settingsPanel(config, status = {}) {
  // Explicit allowlist: publicData() also contains identities and is not a chat payload.
  return {
    mode: 'settings', title: '适配器设置', subtitle: '主人可查看与修改 · 所有设置作用于当前适配器账号',
    connection: states[status.state] || '状态未知',
    rows: chatSettings.map(item => ({ name: item.name, value: settingValue(item, config[item.key]), enabled: !item.factor && config[item.key] === true, numeric: Boolean(item.factor), usage: item.factor ? item.min + '–' + item.max + ' ' + item.unit : '开启 / 关闭', note: item.note || '', example: '#QQBot设置' + item.name + (item.factor ? defaults[item.key] / item.factor : '开启') })),
    notices: ['修改示例：#QQBot设置免艾特开启 ｜ #QQBot设置请求超时30', '单项恢复默认：#QQBot设置图片艾特默认', '保存后先发送确认，再重新加载连接；这期间可能短暂离线。', '开关表示本地配置，不代表 QQ 平台已授予对应权限。', '账号启停、密钥、主人授权、身份映射、白名单等在锅巴管理配置。']
  };
}

export function helpPanel() {
  return {
    mode: 'help', title: 'QQBot 使用帮助', subtitle: 'QQ 官方机器人适配器 · 为云崽插件连接消息与接口',
    sections: [
      { title: '常用入口', items: [
        { command: '#QQBot帮助', description: '查看这张帮助图，所有人可用。' },
        { command: '#QQBot设置', description: '查看常用开关与参数，仅主人可用。' },
        { command: '#QQBot设置免艾特开启', description: '修改单项设置；支持空格分隔。' },
        { command: '#QQBot设置图片艾特默认', description: '将这一项恢复为默认值。' }
      ] },
      { title: '常用设置', items: [
        { command: '免艾特 · 图片艾特', description: '控制群消息接收与同条 @ 图片排版。' },
        { command: '群通知 · 群管兼容 · 主动消息', description: '控制对应接口的本地开关。' },
        { command: '回复窗口 · 回复次数', description: '分别设置群聊、私聊回复时间和次数上限。' },
        { command: '请求超时 · 图片上限 · 媒体上限', description: '数值分别使用秒、MiB，范围见设置图。' }
      ] },
      { title: '消息与插件', items: [
        { command: '文字 / 图片 / 语音 / 视频 / 文件', description: '经标准消息接口发送；具体解析由业务插件完成。' },
        { command: 'Markdown / 按钮 / 卡片 / @ / 引用', description: '已接入对应元素，实际可用性取决于平台授权。' },
        { command: '分享卡片与合并内容', description: '卡片交业务插件解析；合并内容按普通消息有序发送。' },
        { command: '群管与撤回', description: '已接入支持的接口；仍需群角色、权限及有效期。' }
      ] }
    ],
    notices: ['使用群指令时先 @ 机器人；免 @ 需本地开关、QQ 接收权限及宿主群配置同时满足。', '本插件提供通用适配，业务指令请查看相应插件的帮助。', '主人由可信配置授权；QQ群主、管理员身份不会自动获得适配器主人权限。', '密钥、主人授权、身份映射等请在锅巴管理配置。']
  };
}

export function panelText(data) {
  const lines = [data.title, 'qqbot-adapter-plugin v' + data.version];
  if (data.mode === 'settings') {
    lines.push('连接：' + data.connection);
    for (const row of data.rows) lines.push(row.name + '：' + row.value + '（' + row.usage + '）' + (row.note ? '\n' + row.note : ''));
  } else for (const section of data.sections) {
    lines.push(section.title);
    for (const item of section.items) lines.push(item.command + '\n' + item.description);
  }
  return [...lines, ...data.notices].join('\n');
}
