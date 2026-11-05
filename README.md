# qqbot-adapter-plugin

Miao-Yunzai 3.1.3 的 QQ 官方机器人适配器，通过 QQ 开放平台接入群聊和 C2C 私聊，为云崽插件提供事件、联系人、消息收发和群管理接口。

> **当前版本：0.2.12。** 本项目提供 QQ 官方机器人适配器及公共接口实现。代码能力、平台权限和客户端显示需要分别验收，不以单项连接结果推断所有插件可用。见 [公共接口基线](docs/PUBLIC-CONTRACTS.md)。

安装使用 `main` 分支。

## 项目目标

本项目面向 Miao-Yunzai 的插件加载与事件机制，将 QQ 官方机器人收到的事件转换为云崽插件可以处理的形式，并通过官方接口发送回复。原有规划中的设计原则和安全边界继续适用。

已经实现并做隔离验证：

- 通过向外 WebSocket 连接 QQ 官方机器人网关，处理鉴权、心跳 ACK 超时、RESUME、断线退避重连和不可重试错误。
- 接收群聊 @、获准接收的非 @ 群消息和 C2C 私聊，以及可选的成员变动、入群申请与按钮交互。
- 发送文本、图片、语音、视频、文件、Markdown、按钮和图文卡片，接入引用、撤回及平台提供的群管理接口。
- 按 Miao-Yunzai 加载与事件接口验证公共兼容性；群聊和 C2C 共用同一套接口规则。
- 按 AppID 和场景隔离平台身份；支持管理员核实后的旧 QQ 数据关联，主人权限仍单独按原始 OpenID 授权。
- 保留一次调用内的消息顺序与不同调用的边界；部分发送失败保留已成功段的消息 ID，未知投递不自动重发。
- 接入锅巴插件，为常用设置提供图形化配置入口。

真实可用范围仍取决于 QQ 开放平台、机器人已开通的场景和权限，以及各云崽插件的实现。**WebSocket 能否接入、群权限和图片发送必须用实际账号确认。** SDK 或历史文档保留该接口不代表平台一定为新账号开放；若账号只支持 WebHook，本版不能接入，不会自动开启入站服务。

## 设计原则

- **适配喵崽：** 以 Miao-Yunzai 的插件加载流程和事件接口为基础，避免假设其他云崽分支的内部接口可直接使用。
- **最小接入：** 仅使用向外发起的 WebSocket 和 HTTPS 请求，不开启 WebHook、对外 HTTP 服务或反向 OneBot 接口。默认禁用连接。
- **保护凭据：** AppSecret 等敏感信息通过本地私有配置管理，不写入仓库或日志，也不通过聊天命令传递。
- **明确身份：** OpenID 与普通 QQ 号不是同一种标识；不提供聊天绑定 QQ 号或自助提权。群 `member_openid` 与 C2C `user_openid` 分别授权。
- **清晰反馈：** 对官方接口或当前适配器不支持的能力，给出明确反馈，不将失败伪装成成功。

## 兼容性与限制

目标为 Miao-Yunzai **3.1.3**、Node.js **24.x**。宿主核心源码的固定提交、SHA256 和验证边界见 [验证记录](docs/VALIDATION.md)。其他云崽分支未声明兼容。

QQ 官方机器人与通过其他协议端登录的普通 QQ 账号在身份、事件和接口能力上存在差异。不同协议端和云崽分支的兼容性需要分别验证，不保证所有业务插件直接可用。

| 能力 | 当前行为 |
| --- | --- |
| 群聊 @ / C2C | 映射为喵崽群聊/私聊消息，向宿主派发一次根 `message` |
| 免 @ 指令 | 开启 `receiveGroupMessages`；还需 QQ 群消息接收授权，以及喵崽对应群 `onlyReplyAt=0`。默认关闭，见 [消息能力说明](docs/CAPABILITIES.md) |
| 接收分享卡片 | 将独立卡片与并行元素映射为云崽标准 `json` 消息元素，完整保留官方卡片结构；由业务插件自行解析卡片字段，免 @ 仍受平台接收授权与宿主群配置约束，不展开引用或聊天记录中的旧内容 |
| 文本 | 字符串、文本元素及已支持元素的数组；每段最多 1500 个 Unicode 字符，过长拆分 |
| 图片 | HTTPS URL、Buffer、Uint8Array、`base64://`、本地普通文件、`file://`；本地支持 PNG/JPEG/GIF/WebP/BMP，默认上限 4 MiB，可配置 |
| 图片排版 | 默认群聊同条消息上方 @、下方图片，私聊不自动 @；尺寸可读的本地 PNG/JPEG/GIF/WebP 走 Markdown 素材，无法取得尺寸等情况退回普通媒体并返回 warning |
| 语音 / 视频 / 文件 | 语音支持 SILK/MP3/WAV/OGG，视频 MP4，普通文件不限格式；本地媒体超过 4 MiB 时分片上传，仍受本地配置及 200 MiB 硬上限约束 |
| Markdown / 按钮 / 卡片 | 已接入原生元素及交互通知；数组和转发节点按内容段绑定键盘，图片内的确认、选择按钮默认保留；平台明确拒绝按钮权限时降级为文字，未知投递不自动重发 |
| @ / 引用 | 群提及使用当前 AppID、场景内的平台身份，支持显式提及发送者及已可信关联的数字 QQ；引用使用已知消息索引，布尔引用缺少索引时返回 warning；@ 全体受角色、授权和额度限制 |
| 撤回 / 定时撤回 | `recallMsg`、`deleteMsg`、第三参数 `{recallMsg:30}`；按适配器两分钟时限和官方权限校验，失败不伪造成功 |
| 合并内容 | `makeForwardMsg` 构建的内容降级为有序普通消息；不伪造原生聊天记录卡片，不自动拼接两次独立发送 |
| 群信息 / 成员查询 | 接入官方查询，保留可获得的昵称、角色和字符串 ID；部分接口需要额外平台权限，不能假定返回完整成员历史 |
| 群管理 | 成员禁言/解禁、移除、黑名单、入群申请和自动审批策略入口已接入；`groupManagement` 用于查询真实机器人群角色，通知由 `receiveGroupNotices` 控制。仍需群内授权，见 [群管兼容说明](docs/GROUP-ADMIN.md) |
| 被动回复 | 默认群聊 240 秒、每条触发至多 5 次；C2C 默认 3600 秒、至多 4 次，也受 `maxReplies` 限制。按原事件时间计算，不刷新旧消息窗口 |
| 主动消息 | `allowProactive` 默认关闭；开启后仅向已观察且在本地允许范围内的联系人发送，平台仍可拒绝。不借用其他会话的被动回复权 |
| 未实现能力 | QQ 频道、完整聊天历史、头像查询、设置群管理员/名片等未声明兼容。可选未实现方法保持缺省；全员禁言写入保留明确拒绝入口，不能用批量成员禁言冒充 |

以上区分“代码已接入”和“账号获准使用”。平台限频、审核、域名要求和群内授权始终优先；后台勾选能力不等于群内已经授权。媒体、交互和群管需要结合实际账号权限和客户端分别验收。

HTTPS 媒体地址交给 QQ 平台拉取，适配器不开放文件服务。普通媒体走官方上传接口；同条 @ 图片走官方 Markdown 素材流程，单张素材不超过 10 MiB，临时素材只清理本次确认归属的对象。素材生命周期和图片排版规则见 [消息能力说明](docs/CAPABILITIES.md)。

## 安装与私有配置

以下步骤用于新环境安装或后续维护。先在隔离副本验证，再将本插件放进喵崽实际加载的 `plugins/qqbot-adapter-plugin` 目录；Docker 部署还需确认插件目录、私有配置和业务数据正确持久挂载。

在喵崽根目录执行（若已经安装，从现有插件目录继续，不重复 clone）：

```sh
git clone --branch main https://github.com/XiaoyuBook/qqbot-adapter-plugin.git plugins/qqbot-adapter-plugin
cd plugins/qqbot-adapter-plugin
npm ci --omit=dev --ignore-scripts
npm run config -- --init
npm run config -- --enable
```

最后一条命令在本地/SSH 的交互终端询问 AppID 和**隐藏输入**的 AppSecret。输入不回显、不接受密钥参数或管道；空密钥保留现值，切换 AppID 必须重新写入密钥。取消输入不保存。工具不会连接 QQ 或重启喵崽；终端保存的配置在下次加载时生效。单纯禁用也可在私有文件中将 `config.enabled` 改为 `false`，或在锅巴页面关闭。

默认私有文件为插件下的 `private/account.json`，目录/文件在 POSIX 系统上使用 **0700/0600**，拒绝符号链接、硬链接和非当前用户所有的文件。Windows 的 chmod 不能代替 ACL，请用受限用户目录和 NTFS ACL 控制访问。JSON 中密钥是磁盘明文，不是加密保险箱；同用户代码或服务器管理员仍可访问。

推荐生产配置放在仓库外，例如由喵崽进程设置 `QQBOT_ADAPTER_PRIVATE_DIR=/var/lib/qqbot-adapter-plugin`。运行配置工具和喵崽必须使用**同一路径、同一运行用户**。不允许将私有目录设置到插件内 `private/` 以外的受版本管理路径。不要把 AppSecret 发到聊天、环境变量命令行、工单、截图、日志或仓库。

`config/default.json` 是可查看的默认值；不会从这里读取凭据。可用 `npm run config -- --init` 生成完整私有文件后，在可信本地编辑器中调整其 `config` 字段。不要通过聊天命令读取或导出 `account.json`。

## 使用准备

使用前需要在 [QQ 开放平台](https://q.qq.com/) 创建官方机器人，并确认账号具备所需的群聊或私聊场景权限。接入所需的 AppID、AppSecret 应妥善保管。

还应核对平台控制台中的服务器出口 IP 白名单、群聊/C2C 场景开通情况、测试成员及沙箱限制、媒体与 URL 权限。连接仅需向官方鉴权域名、API 域名发出 HTTPS/WSS 请求；不需要为本插件开放入站端口。AppID 本身不是主人 QQ 号。

## 锅巴配置

已经实现 `guoba.support.js`，锅巴配置页提供 AppID、只写 AppSecret、连接、消息、访问白名单与主人 OpenID 配置。`getConfigData()` 始终返回 `appSecret: ""` 与布尔 `secretConfigured`；保存结果和错误不回传提交字段。空输入保留现有密钥，不提供页面查看或清空密钥功能。保存后只重新加载本适配器的连接，**不重启喵崽、NapCat 或其他服务**。

锅巴页面的密码遮罩只是显示方式，不等于加密。只在可信管理终端的 HTTPS 或 SSH 隧道中写入；密钥会经过浏览器和锅巴请求，浏览器扩展、外部代理的请求录制或其他插件不受本插件控制。首次也可使用本地隐藏输入工具。

列表每行一个原始 OpenID：`masterGroupOpenids` / `masterC2COpenids` 为空时不授权主人，`allowedGroupOpenids` / `allowedC2COpenids` 为空时允许该场景全部消息。只有可信管理员从受控测试身份确认 OpenID 后才能加入主人列表，不能把陌生人自报的值当成身份凭据。

免 @、成员通知、群管角色兼容和主动发送是分别配置的开关。QQ 资料页的“接收机器人推送 / 允许主动发送消息”不表示已经允许机器人接收全部群消息；喵崽的群过滤规则也独立生效。

## 插件接口与身份

```js
// 业务插件在自己的事件处理器内使用：
await e.reply('文字回复')
await e.reply(segment.image(pngBuffer))
await e.group?.sendMsg('当前群事件的被动回复')
await e.friend?.sendMsg('当前 C2C 事件的被动回复')
```

`e.reply`、事件联系人 `sendMsg` 和允许的主动发送共用消息转换与回执。一次调用的元素保序，不同调用分别排队；文本与紧随的图片可合为带说明的媒体消息。群图片默认使用同条消息上方 @、下方图片；可用第三参数 `{at:false}` 关闭本次自动图片提及。

```js
const result = await e.reply('需要确认结果的回复', false, { receipt: true })
if (result.ok) {
  // 所有段均收到成功消息 ID。
} else {
  // status 为 partial / rejected / unknown；不要直接重发整条消息。
  // message_ids 保留已确认成功的段，failure 说明失败阶段与投递状态。
}
```

成功结果保留 `{message_id,message_ids,seq,time}`，另含 `ok/status/sent/total_parts/completed_parts`。默认零成功段失败仍返回 `false`；部分成功返回 `ok=false,status=partial` 的回执并保留成功 ID，不能只按对象真假判断全部成功。`receipt:true` 让零成功段失败也返回详细回执；最近处理结果与错误在 `e.qqbot.lastReceipt/lastError`。回执不包含上游正文或凭据；网络超时、无效消息响应或 5xx 不能确定是否投递时，不自动重发。

第三参数支持 `at`、`recallMsg`（0–120 秒）、`button/keyboard` 和 `receipt`。`at` 可用布尔值、当前场景的命名空间 ID 或可信映射中的 QQ 字符串/安全整数。`button:false` 或 `keyboard:false` 可显式隐藏本次调用的按钮。引用对象使用已知消息记录或 `ref_idx`；`quote=true` 缺少显示索引时降级为普通被动回复并记录 `quote_display_unavailable`。群聊中的显式 @ 保留，同一内容段内的同目标提及去重，`{at:false}` 仅关闭自动图片提及；私聊中对当前收件人的 @ 省略并返回 warning。完整输入、返回、宿主包装与限制见 [公共接口基线](docs/PUBLIC-CONTRACTS.md)。

插件包装 `e.reply` 时，第三参数继续传给下一层。包装链内省略参数或传入空对象会继承已有选项，显式字段覆盖继承值（包括 `false` 和 `0`）；不同发送调用独立处理，撤回由适配器按已成功段调度一次。

- 账号：`qqbot:<AppID>`，注册到 `Bot[账号]`，在线时将其 ID 加入 `Bot.adapter`。
- 群：`qqbot:<AppID>:group:<group_openid>`。
- 群用户：`qqbot:<AppID>:group-user:<member_openid>`。
- 私聊用户：`qqbot:<AppID>:c2c-user:<user_openid>`。

原始标识在 `e.qqbot.userOpenid` / `groupOpenid`，完整平台主体在 `principalId`。昵称优先使用平台可获得的信息，缺失时才使用占位。`e.isMaster` 只承认本地 OpenID 授权，即使宿主 `masterQQ` 意外含对应标识也不能提权。授予群场景主人会适用于该 AppID 下匹配的 member_openid；可结合群白名单进一步限制。

`userIdMappings` 可由可信管理员将完整平台主体关联到既有 QQ 数据归属字符串，未关联者继续使用命名空间 ID。群聊与 C2C 分别关联，出站寻址仍还原为对应平台 OpenID；关联到主人 QQ 不会授予主人权限。**这是一项数据关联配置，不是 QQ 号所有权认证**；没有聊天自报 QQ 自动绑定或双端验证码认证。审计和离线迁移工具的范围见 [身份与数据关联记录](docs/IDENTITY.md)。

适配器不替换全局 Bot、不更改 `Bot.uin`，也不包装根 `Bot.pickFriend/pickGroup`。插件应使用 `e.bot`、`Bot[e.self_id]`、`e.group`、`e.friend`。账号的 `getGroupList/getFriendList` 返回已观察联系人 Map 的副本，记录的 `uin` 可用于选择所属账号；`fl/gl` 不代表完整平台列表。成员归属通过 `member.group`、`member.info.group_id` 表达。未实现的可选方法不挂抛错占位，插件可正常探测并选择自己的替代方式。停止时只注销本账号。

去重覆盖当前进程的连接恢复和同 AppID 配置重载，默认保留两小时，最多 20000 个事件键；满载时拒绝新事件，不淘汰仍有效的记录。它不是跨进程事务或持久化恰好一次机制；进程崩溃、重启后的业务副作用仍需业务插件自身幂等。

## 验证与维护

```sh
npm ci --ignore-scripts
npm test
npm run fixtures
npm run test:contracts
npm run test:host
npm run check
npm audit --omit=dev
```

`fixtures` 只下载固定提交的公开源码并校验 SHA256，保存在被忽略的 `.verification-cache/`；宿主测试不连接 QQ、Redis 或生产数据。无法访问 raw.githubusercontent.com 时，可从已导出的本地宿主源码导入：`npm run fixtures -- --from-host <源码快照目录>`；校验要求不变。普通测试无需外部网络；wire 测试只在回环地址启动临时模拟服务。

升级先在隔离副本运行上述检查，停用本适配器并保留仓库外的私有配置，仅替换本插件文件、执行插件目录的 `npm ci --omit=dev --ignore-scripts`；之后在授权的维护窗口重新加载。不要对喵崽根依赖或其他插件执行更新。

回滚：在锅巴禁用连接；若需移除，在维护窗口停喵崽，把整个插件目录移到 **plugins 目录之外**，再按现有运维流程启动并核验 NapCat。不要只在 plugins 内改名，喵崽仍可能加载它。私有配置单独安全保留或由管理员明确删除，不创建整套源码/容器备份。专项业务兼容补丁按其固定源码校验和回退，不能把更新适配器视为已更新所有业务插件。

## 开发计划

开发按公共接口推进，具体插件用于集成验收，核心逻辑依账号、场景、消息元素、显式选项和平台结果作决定。

1. **兼容基线：** 0.2.9 完善回复包装、身份输入、显式提及及多键盘规划，群聊/C2C 共用固定宿主测试入口。
2. **身份与宿主：** 已覆盖可信关联、撤销与重载、跨账号/场景隔离和 NapCat 两种加载顺序；继续扩展宿主数据读写方的合同。
3. **消息发送：** 已验证顺序、调用边界、并发路由、部分成功、权限拒绝及未知投递；后续消息表达沿同一探针增加覆盖。
4. **能力发布：** 媒体、交互和群管分别记录代码、宿主、真实账号 API 与客户端证据；未逐项验收的功能不宣称全面可用。

完整步骤见 [开发路线](docs/ADAPTER-ROADMAP.md)。现有小瑶、椰奶等特定快照的兼容补丁，其适用、启用和移除条件单独登记在 [公共接口基线](docs/PUBLIC-CONTRACTS.md#已有业务兼容补丁的归属)，不会随普通安装自动修改其他插件。

测试通过的范围和已知限制会随版本更新，避免将模拟测试结果视为线上业务验收。

## 参考资料

- [QQ 机器人官方文档](https://bot.q.qq.com/wiki/)
- [QQ 机器人官方文档仓库](https://github.com/tencent-connect/bot-docs)
- [实现与第三方核查](THIRD_PARTY.md)
- [公共接口基线与探针](docs/PUBLIC-CONTRACTS.md)
- [验证方法与范围](docs/VALIDATION.md)

## 许可证

本项目的开源许可证仍未选定，`package.json` 暂标记 `UNLICENSED`，尚未授予公开再分发许可。适配器实现独立编写，没有复制参考插件的产品源码；第三方协议资料、运行依赖和测试用公开源码各自的许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。
