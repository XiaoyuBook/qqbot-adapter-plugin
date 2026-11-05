# QQBot 公共接口基线 · 0.2.9

本表落实 [开发路线](ADAPTER-ROADMAP.md) 第一阶段，并登记本次在身份、联系人和发送回执上修复的通用差异。目标宿主为 Miao-Yunzai 3.1.3，支持 QQ 官方群聊和 C2C。使用这些接口的插件共用相同规则；测试探针不包含游戏、群管或其他业务。

## 参考、执行环境与证据范围

- **调用合同主参考**：[Pimeng 插件调用用例](https://github.com/Pimeng/QQBot-plugin/blob/d33f347f57d9474c8be680da5aa488b1e6267065/tests/plugin-contracts.test.mjs) 及 [事件转换](https://github.com/Pimeng/QQBot-plugin/blob/d33f347f57d9474c8be680da5aa488b1e6267065/lib/utils/events.js)，重点取账号选择、联系人、Map 遍历、宿主回复包装及回执消费方式。
- **身份参考**：[Lain 的 ID 映射](https://github.com/win-syswow64/Lain-plugin/blob/d7af609600f7f14fd107de2cf611af9d56ed2250/model/qqbot-id-map.js)。本项目只采用 AppID/场景隔离和正反向寻址的原则，关联与主人授权仍依本项目可信配置；不复制基于消息同时出现等条件的自动关联策略。
- **消息参考**：[TimeRainStarSky 消息构建与发送](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin/blob/60a2e87d82aef2940e2b6d299f2ae2b45519fd4b/index.js#L531-L673)。借鉴发送步骤与回执收集的职责划分，不采用失败后重发整条消息的处理。
- 宿主源文件与 NapCat 版本固定在 [manifest](../test/host/manifest.json)，加载前校验 SHA256。探针实际执行这些源文件的 Loader、Message Listener、Runtime 和 ICQQ 0.6.10 事件总线。网络使用桩；NoteUser 数据源使用隔离替身，验证 Runtime 传递的数据归属标识，不把它声称为真实用户数据库的全面验收。

下文“宿主通过”指上述固定源码环境中的自动测试通过，不等于腾讯已经授予接口权限，也不等于手机 QQ 已完成视觉验收。

## 首批接口对照

| 接口 / 输入 | 返回或行为 | 场景与边界 | 0.2.9 差异处理及证据 |
| --- | --- | --- | --- |
| `Bot[e.self_id]`、`e.bot` | 同一 QQBot 账号，`adapter='QQBot'`，`isOnline()` 返回连接状态 | 群、C2C；不替换根 Bot 默认账号 | 宿主通过。`public-contracts` 账号探针、NapCat 两种启动顺序；保留根账号行为 |
| `e.user_id`、`e.sender.user_id` | 未关联为 `qqbot:AppID:group-user/c2c-user:OpenID`；可信关联返回既有 QQ 数据标识字符串 | AppID、群/私聊分域；`e.qqbot.principalId` 保留平台主体 | 宿主通过。探针覆盖关联、重载、撤销、切换 AppID、私聊不继承群关联；Runtime 传递同一数据归属 |
| `e.isMaster` | 仅取本账号对应场景的 OpenID 授权，固定 getter | 映射到旧 QQ、宿主 masterQQ、入站自称身份均不增加权限 | `public-contracts` 与 `integration`、`user-mapping` 覆盖；不是 QQ 号码所有权认证 |
| `account.pickGroup(groupId)` | 已观察群的联系人，`info.group_id` 和 `group_id` 可读 | 只接受本账号群标识；未知群拒绝，不推断数字 QQ 群号 | 群探针实际取联系人并发送、消费回执；旧事件联系人不因新事件改变路由 |
| `account.pickFriend(userId)` / `pickUser` | 已观察 C2C 好友联系人，保留字符串 ID | 群成员 OpenID 不能用于推断 C2C 身份 | C2C 探针及跨场景拒绝测试；私聊 `getInfo/getSimpleInfo` 返回已观察资料副本 |
| `group.pickMember(userId)` / `account.pickMember(groupId,userId)` | 群成员联系人；`member.group` 指向群联系人，`info.group_id` 正确 | 群；成员的 `sendMsg` 不能代替官方不支持的“群成员转私聊” | **修复缺失的群归属**；成员资料/权限依缓存或官方查询。群探针与已有群管合同覆盖 |
| `account.getGroupList/getFriendList()` | Promise → Map 副本；`getGroupMap/getFriendMap()` 为同步 Map 副本 | **仅本进程观察到的联系人**，不是完整平台列表；重载后重新积累 | **替换未实现占位**；记录补 `uin`，群记录补 `group_name`；可遍历后用 `Bot[info.uin]` 路由。清空返回 Map 不会清空内部 Map |
| 可选方法探测，如 `if (contact.getAvatarUrl)` | 实现存在才暴露，调用方可走自己的替代方案 | 未实现的历史、头像、文件 URL、戳一戳、改名片等不挂假函数；账号 `getMsg/setGroupAdmin/...` 同理 | **移除通用抛错占位**；探针断言缺省，原神探索度业务回归继续通过 |
| `group.muteAll` / `account.setGroupWholeBan` | 明确拒绝 `GROUP_WHOLE_MUTE_UNSUPPORTED` | 既有群管调用的明确拒绝入口，不能作为可选能力探测；不以批量禁言伪造全员禁言 | 已声明的受限兼容入口；见 [群管范围](GROUP-ADMIN.md) |
| `e.reply(message,quote?,extra?)` | 成功回执；默认零成功段失败为 `false`，部分成功返回带成功 ID 的回执 | 非空文本、已支持元素、元素数组及本适配器转发构造；群与 C2C | **修复部分发送丢回执**。真实宿主两参包装后第三参仍由异步上下文传递 |
| 事件内 `group/friend.sendMsg(...)`、同目标 `pick*().sendMsg(...)` | 与 `e.reply` 共用同一发送器、队列、额度、转换和回执 | 只复用同一账号、场景、目标的事件上下文 | 探针覆盖两种入口混用与并发群/私聊；不借用另一会话的消息 ID |
| `account.sendGroupMsg/sendPrivateMsg`、事件外联系人发送 | 已观察目标且 `allowProactive` 允许时主动发送 | 没有被动 msg_id/msg_seq；本地开关不能赋予腾讯权限。未允许时抛 `PASSIVE_ONLY` | 主动探针使用网络桩；实际发送仍需账号与范围校验 |
| 一次 `reply([图片,文本])` | 按序发图片，再发文本；回执记录全部成功段 | 组合内保序；文本在图片前时可合为该图片的说明 | 探针替换插件名、命令、文案，报文边界相同；不按业务内容合并 |
| 两次 `reply(a)`、`sendMsg(b)` | 两次独立调用，按同一触发的队列先后发送 | 不因时间接近或文案相同而拼接；各自返回回执 | 探针覆盖连续和并发调用；插件自己延迟到结束才调用的行为不由核心猜测 |
| `extra={at,recallMsg,button/keyboard,receipt}` | 校验后进入公共处理；`recallMsg` 为 0–120 秒 | 引用使用已知 ref_idx；未知显式引用拒绝；布尔引用可返回不可显示的 warning | 原宿主 options 回归保留；`receipt` 新增为布尔选项。`warnings` **只属于本次发送**，不泄漏前一次降级 |
| `extra.receipt=true` | 无论零段失败还是部分成功，返回下节的完整回执 | `e.reply`、事件联系人和允许的主动发送都支持 | `send-receipts` 覆盖上传失败、403、502、超时、无效响应；`public-contracts` 覆盖宿主包装后的分段失败 |
| 重连重放、配置重载和旧联系人 | 同 AppID 去重窗口内不再次执行业务；旧联系人离线不能发送 | 切换 AppID 不共享主体；每个账号只清理自己的注册和状态 | 探针实际调用 Controller reload，两个 NapCat 启动顺序均通过；原 transport/wire 测试仍验证 READY、RESUME、心跳及重放 |

## 选项与内容段规则

- 包装链内省略第三参数或传入空对象会继承选项；显式提供的字段逐项覆盖，`false` 和 `0` 也生效。`undefined` 字段等同省略。切换 `button/keyboard` 选项时，新字段替换旧字段。直接联系人发送和不同事件不继承外层回复的选项。
- 全局 `segment.button` 与账号 `segment.button` 使用相同转换；图片加确认/选择按钮默认保留。`button:false` 或 `keyboard:false` 显式隐藏本次按钮，并记录 `keyboard_omitted_by_option`；不按插件名、指令或文案删除按钮。
- 每个键盘属于它之前尚未绑定键盘的内容段，绑定后关闭该段。之后的正文进入下一段；独立键盘有自己的提示段。转发节点边界保留，嵌套转发和直接数组共用规划。规划全部完成后才检查总额度并上传媒体。
- 群聊显式提及发送者正常发送。同段提及按解析后的平台身份去重；紧随的可读尺寸本地图片使用同条消息的“上方 @、下方图片”。`at:false` 关闭自动提及，不删除调用方已放入消息的显式元素。远程图片无法取得尺寸时，显式提及保留在前一文字段，图片使用普通媒体，并记录排版 warning。
- `at` 接受布尔值、命名空间身份和可信映射中的 QQ 字符串或正安全整数。所有身份解析复用当前 AppID 与场景的映射；不猜测原始 OpenID，不跨群私聊或 AppID 借用关联。C2C 对当前收件人的提及省略并返回 `private_self_mention_omitted`，其他提及拒绝。

`test/host/message-planning.test.js` 使用同一探针覆盖上述行为、回复包装、并发、正常与主动入口、分段失败、撤回和临时素材生命周期；已纳入 `npm run test:contracts`。

## 回执规则

成功和部分成功都保留旧插件使用的 `message_id`（最后一个已成功段）、`seq`、`time` 及可用的 `ref_idx`。`message_ids` 为全部已成功段；`sent` 保存各段原始兼容回执。不会为未知投递伪造 ID。

```js
const receipt = await e.reply(message, false, { receipt: true });
// receipt.ok: 只有所有业务段成功时才为 true
// receipt.status: success | partial | rejected | unknown
// receipt.total_parts / completed_parts: 计划段数 / 已确认成功段数
// receipt.message_ids / sent: 已确认成功的业务段，可用于逐段撤回
// receipt.failure: { code, message, delivery, stage, part_index, status?, platformCode? }
```

| 状态 / failure.delivery | 含义与调用方处理 |
| --- | --- |
| `success` | 所有段收到有效成功消息 ID |
| `partial` | 至少一段成功；后续停止。保留 ID；进一步看 `failure.delivery`，不能重发整条消息 |
| `rejected` + `not_sent` | 当前失败段在校验、额度/连接检查、素材上传等阶段停止，没有向消息接口投递 |
| `rejected` + `rejected` | 当前失败段被平台明确拒绝，且没有已成功段 |
| `unknown` + `unknown` | 消息 POST 超时、响应无效、HTTP 5xx 等，无法确定是否已经投递；不自动重发 |

`stage` 为 `validation/upload/message`；`part_index` 从 0 开始。规划前失败时 `total_parts=0` 表示没有完成规划，不表示原消息没有内容。部分成功的 `failure.delivery` 同样适用于当前失败段；`unknown` 之外未执行的后续段也不会继续发送。

为保留旧插件行为，未启用 `receipt` 时零成功段失败仍返回 `false`；这时可以读 `e.qqbot.lastReceipt`。部分成功即使未启用选项也返回 `ok=false,status=partial` 的对象，使成功 ID 可被保留。需要判断全部成功的调用方应检查 `ok`，不能只判断对象真假。回执及其数组/段记录冻结，后续发送不会修改前一次回执。

`lastReceipt` 是该事件发送器最后一次**适配器已处理**的发送结果，联系人发送也更新它；并发时应直接保存各调用返回值。宿主在进入适配器前拦截空消息或禁言时，可能直接返回 `false`，不产生新的适配器回执。既有 `lastError` 仍表示最后一次错误，不因后续成功清除。兼容提醒气泡不计入业务段回执，但仍消耗平台回复额度。

## 探针与重复执行

`test/host/contract-probe.js` 导出 `createContractProbe(Plugin, options)`，只做“从事件选择账号 → 取联系人 → 回复 → 消费结果”。默认群聊和 C2C 使用同一处理函数；测试用 `exercise/onResult` 注入调用与断言，用 `name/pattern` 变化调用方名称和指令。它不按插件名或命令改变适配器策略，也不默认加载进生产机器人。

```sh
npm ci --ignore-scripts
npm run fixtures
npm run test:contracts
npm run test:host
npm test
npm run check
```

`test/host/public-contracts.test.js` 是真实宿主公共合同入口，`test/send-receipts.test.js` 补充失败边界。探针可被后续能力测试复用，不需要复制业务命令来证明通用接口可用。


## 验证边界

公共接口探针使用固定版本宿主源码、虚构身份和隔离网络。它验证接口形状、路由、发送边界及回执，不证明实际账号已取得权限，也不替代 QQ 客户端的媒体和交互显示验收。更广的插件调用、消息组合和数据读写路径需要继续增加覆盖。

## 已有业务兼容补丁的归属

| 补丁 | 适用版本与启用条件 | 移除条件 |
| --- | --- | --- |
| 小瑶抽卡更新进度 | `scripts/prepare-gacha-progress-patch.mjs` 固定输入 SHA256；仅该快照的 QQBot 更新分支，把插件已产生的进度及时交出。不会由核心识别抽卡指令 | 上游自己及时调用回复、保持调用边界且通过进度回归时，撤销此外部文件补丁 |
| 椰奶群管 ID / 目标选择 | `scripts/prepare-yenai-group-patch.mjs` 固定三个输入 SHA256，椰奶 2.0.0 安装快照；仅 QQBot 分支避免数字强转、使用真实禁言列表及筛除触发机器人 @ | 上游支持字符串主体和公共群管接口，重新抽验普通用户权限、其他协议及相同调用后撤销 |
| 可选结果导航 | `scripts/prepare-result-navigation-patch.mjs` 校验固定 Miao 3.1.3 的 `role.js`、`ledger.js`；仅 QQBot 的九处完成结果图省略附带导航，其他适配器保留原调用 | 上游按场景显式选择导航后可撤销；核心发送器不按按钮来源、文字或命令猜测用途 |

兼容迁移脚本只对校验匹配的固定输入生成独立输出；源码漂移或重复应用会拒绝。升级时须重新比对，不能在版本未知的业务文件上自动套用。
