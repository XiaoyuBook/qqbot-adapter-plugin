import { defaults } from './config.js';
import { isMaster } from './identity.js';

const MiB = 1024 * 1024;
export const chatSettings = Object.freeze([
  { key: 'receiveGroupMessages', group: '消息与权限', name: '免艾特', description: '接收未 @ 机器人的群消息', aliases: ['免@'], note: '还需 QQ 群允许接收全部消息，以及宿主对应群 onlyReplyAt=0。' },
  { key: 'mentionBeforeImage', group: '消息与权限', name: '图片艾特', description: '群图片上方自动 @ 发送者', aliases: ['图片@'], note: '群聊同条消息上方 @、下方图片，私聊按普通图片发送。' },
  { key: 'receiveGroupNotices', group: '消息与权限', name: '群通知', description: '接收入群申请与成员变动', note: '接收入群申请和成员变动，需 QQ 平台授权。' },
  { key: 'groupManagement', group: '消息与权限', name: '群管兼容', description: '查询机器人在群内的真实角色', note: '查询真实群角色，群管功能还需平台与群内授权。' },
  { key: 'allowProactive', group: '消息与权限', name: '主动消息', description: '允许主动发送给已知联系人', note: '允许向已知联系人主动发送，受平台额度限制。' },
  { key: 'replyWindowSeconds', group: '回复策略', name: '群回复窗口', description: '群聊被动回复的有效时间', unit: '秒', min: 1, max: 300, factor: 1 },
  { key: 'c2cReplyWindowSeconds', group: '回复策略', name: '私聊回复窗口', description: '私聊被动回复的有效时间', unit: '秒', min: 1, max: 3600, factor: 1 },
  { key: 'maxReplies', group: '回复策略', name: '回复次数', description: '每条触发的回复上限', unit: '次', min: 1, max: 5, factor: 1, note: '每条触发的本地上限，C2C 另受最多 4 次限制。' },
  { key: 'requestTimeoutMs', group: '资源限制', name: '请求超时', description: '接口请求的等待时间', unit: '秒', min: 1, max: 120, factor: 1000 },
  { key: 'maxImageBytes', group: '资源限制', name: '图片上限', description: '本地单张图片大小上限', unit: 'MiB', min: 1, max: 200, factor: MiB, note: '本地大小上限，同条 @ 图片还受素材 10 MiB 限制。' },
  { key: 'maxMediaBytes', group: '资源限制', name: '媒体上限', description: '本地语音、视频、文件大小上限', unit: 'MiB', min: 1, max: 200, factor: MiB, note: '本地语音、视频、文件上限，平台仍可能另有限制。' }
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
  if (!input || ['帮助', '列表'].includes(input)) return { type: 'view' };
  for (const item of chatSettings) {
    const name = [item.name, ...(item.aliases || [])].find(name => input.startsWith(name));
    if (!name) continue;
    const value = input.slice(name.length).trim();
    if (!value) return { type: 'query', item };
    const hint = item.factor ? item.name + '请输入 ' + item.min + '–' + item.max + ' 的整数，可带单位「' + item.unit + '」，或输入「默认」。' : item.name + '请输入「开启 / 关闭」「开 / 关」或「默认」。';
    let next;
    if (['默认', '恢复默认'].includes(value)) next = defaults[item.key];
    else if (!item.factor && ['开启', '开', '启用', '关闭', '关', '禁用'].includes(value)) next = ['开启', '开', '启用'].includes(value);
    else if (item.factor) {
      const numeric = /^(\d+)\s*(秒|次|MiB)?$/i.exec(value);
      const unitMatches = numeric && (!numeric[2] || numeric[2].toLowerCase() === item.unit.toLowerCase());
      const number = unitMatches ? Number(numeric[1]) : NaN;
      if (Number.isSafeInteger(number) && number >= item.min && number <= item.max) next = number * item.factor;
    }
    return next === undefined ? { type: 'invalid', message: hint } : { type: 'set', item, patch: { [item.key]: next } };
  }
  return { type: 'invalid', message: '请发送 #QQBot设置 查看可用项目。\n查询单项用 #QQBot设置免艾特\n修改用 #QQBot设置免艾特开启\n恢复单项用 #QQBot设置免艾特默认\n密钥、主人授权、身份映射等请在锅巴管理中配置。' };
}

const states = { online: '已连接', connecting: '连接中', reconnecting: '重连中', blocked: '连接受限', stopped: '已停止', disabled: '未启用', error: '应用配置失败' };
function settingExample(item) {
  return '#QQBot设置' + item.name + (item.factor ? defaults[item.key] / item.factor + item.unit : '开启');
}

export function settingsPanel(config, status = {}, selectedItem) {
  const items = selectedItem ? chatSettings.filter(item => item === selectedItem) : chatSettings;
  const rows = items.map(item => ({
    group: item.group, name: item.name, value: settingValue(item, config[item.key]),
    enabled: !item.factor && config[item.key] === true, numeric: Boolean(item.factor),
    usage: item.factor ? item.min + '–' + item.max + ' ' + item.unit : '开启 / 关闭',
    defaultValue: settingValue(item, defaults[item.key]), note: item.note || '',
    example: settingExample(item)
  }));
  // Explicit allowlist: publicData() also contains identities and is not a chat payload.
  return {
    mode: 'settings', title: selectedItem ? selectedItem.name + '设置' : '适配器设置',
    subtitle: '仅主人可用 · 当前账号全部会话生效',
    quickCommand: '#QQBot设置<项目><值>', quickDescription: '例如 #QQBot设置请求超时30秒',
    connection: Object.hasOwn(states, status.state) ? states[status.state] : '状态未知', online: status.state === 'online',
    rows,
    groups: [...new Set(rows.map(row => row.group))].map(title => ({ title, rows: rows.filter(row => row.group === title) })),
    notices: [
      '单项查询用 #QQBot设置' + (selectedItem?.name || '免艾特'),
      '恢复单项用 #QQBot设置' + (selectedItem?.name || '免艾特') + '默认',
      '支持 开 / 关、启用 / 禁用，项目和值之间可加空格。',
      '修改后自动重连，短暂离线后可再次查看状态。',
      'QQ 平台权限需另行开通。账号、密钥与身份关联在锅巴管理配置。'
    ]
  };
}

export function helpPanel() {
  const settingItem = item => ({
    command: settingExample(item),
    description: item.description,
    usage: item.factor ? item.min + '–' + item.max + ' ' + item.unit : '开启 / 关闭'
  });
  return {
    mode: 'help', title: 'QQBot 使用帮助', subtitle: '命令速查 · 群聊请先 @ 机器人',
    quickCommand: '#QQBot设置免艾特开启', quickDescription: '按下方示例输入命令，修改对应项目',
    sections: [
      { title: '查看与查询', permission: '帮助公开 · 设置仅主人', items: [
        { command: '#QQBot帮助', description: '查看这份命令菜单', usage: '所有人可用' },
        { command: '#QQBot设置', description: '查看当前开关、参数与连接状态', usage: '仅主人' },
        { command: '#QQBot设置免艾特', description: '查询单项当前值与修改方法', usage: '仅主人 · 可替换为下方任一项目' },
        { command: '#QQBot设置请求超时', description: '查询参数当前值、默认值与范围', usage: '仅主人 · 项目名后留空即可查询' }
      ] },
      { title: '开关设置', permission: '仅主人', items: chatSettings.filter(item => !item.factor).map(settingItem) },
      { title: '参数设置', permission: '仅主人 · 将示例数字换为所需值', items: chatSettings.filter(item => item.factor).map(settingItem) },
      { title: '恢复默认', permission: '仅主人 · 按单项恢复', items: [
        { command: '#QQBot设置免艾特默认', description: '将免艾特恢复为默认值', usage: '可替换为任一设置项目' },
        { command: '#QQBot设置请求超时恢复默认', description: '将请求超时恢复为默认值', usage: '默认 / 恢复默认 均可' }
      ] }
    ],
    notices: [
      '开关支持 开启 / 关闭、开 / 关、启用 / 禁用。数值可省略单位。',
      '项目和值之间可加空格。#QQ机器人 可代替命令中的 #QQBot。',
      '设置对当前账号全部会话生效，修改后自动重连。',
      '免艾特需 QQ 接收权限及宿主群配置。平台限制详见单项查询。'
    ]
  };
}

export function panelText(data) {
  const lines = [data.title, 'qqbot-adapter-plugin v' + data.version, data.quickCommand, data.quickDescription];
  if (data.mode === 'settings') {
    lines.push('连接：' + data.connection);
    for (const group of data.groups) {
      lines.push(group.title);
      for (const row of group.rows) lines.push(row.name + '：' + row.value + '（' + row.usage + '）', '默认 ' + row.defaultValue, row.example, ...(row.note ? [row.note] : []));
    }
  } else for (const section of data.sections) {
    lines.push(section.title + '（' + section.permission + '）');
    for (const item of section.items) lines.push(item.command + '\n' + item.description + ' · ' + item.usage);
  }
  return [...lines, ...data.notices].join('\n');
}
