# 群管理接口与授权

适配器提供官方群管理接口。平台控制台能力、群内角色和群内授权分别生效；调用失败时返回真实结果，不伪造成功。

## API 与插件入口

| 能力 | 已适配入口与行为 |
| --- | --- |
| 撤回 | `e.group.recallMsg`、`e.bot.deleteMsg`；保留消息作用域、两分钟窗口和去重 |
| 入群申请列表/审批 | `getJoinRequests`、`approveJoinRequest`、`e.approve`；增加 `e.bot.getSystemMsg()`、`setGroupAddRequest(flag,approve,reason,block)` 的常见调用 |
| 执行自动审批策略 | `e.bot.getJoinApprovalStrategies`、`e.bot/e.group.executeJoinApprovalStrategy`；先查策略关联范围，再提交执行，只报告 `accepted:true`，不冒充已经通过所有申请 |
| 禁言状态/成员禁言 | `getMuteState`、`getMutedMembers`、`muteMember`、成员对象 `mute`，兼容群对象 `mute` 与账号 `setGroupBan`；0 表示解禁，最多 30 天 |
| 移除群成员 | `kickMember`、`removeMembers`、群/成员 `kick` 与账号 `setGroupKick`；支持旧插件布尔拉黑参数及 ICQQ 的空理由槽 + 拉黑参数。官方移除接口没有理由字段，非空理由明确报错 |
| @ 全体 | `segment.at('all')` 转官方 `<qqbot-at-everyone />` |

当前文档中 @ 全体要求机器人为群管理员，每群自然日一次；成员列表/移除接口仍带内邀说明，是否可用取决于该账号实际授权与返回，失败不会伪造成功。禁言写入只接受成员列表，未发现全员禁言写入字段，`muteAll/setGroupWholeBan` 明确报错。设置管理员、群名片、头衔等当前未提供对应适配，不能由后台“发言管理”概括推定支持。

## 权限、事件与身份

- 新增可选 `groupManagement` 开关，查询并缓存官方 `bot_state.member_role`，让 `e.group.is_admin/is_owner`、自身成员对象及椰奶原有权限检查得到真实状态；管理员身份不授予本地主人权限。状态未知或查询失败时权限为 false，普通消息仍可处理。
- 首个群消息可能等待一次状态查询；已知群的过期缓存后台刷新。自动查询每分钟最多 25 次，成功缓存 60 秒、失败缓存 30 秒。平台仍会在实际群管请求上校验权限，缓存不代表授权凭据。
- 修正入退群事件为 `notice.group.increase/decrease`，申请为 `request.group.add`；根 Loader 与直接 `Bot.on(...)` 子事件监听各一次。`receiveGroupNotices` 仍独立控制接收。
- 入群申请 flag 是当前进程生成并绑定 AppID/群/申请人的不透明令牌。只处理已收到或在当前群真实拉取的申请；拒绝裸请求 ID、自造 flag、其他账号/群的 flag，以及过期令牌；并发相同决定去重、相反决定拒绝。
- 自动审批执行会扫描策略关联的全部群。群事件或群对象调用只允许明确关联该群的策略；有本地群白名单时逐个验证关联 OpenID，无法从掩码群号确认范围时拒绝提交。无群上下文且未配置本地群白名单的账号级调用作用于该应用的完整策略范围，供受信任插件调用。
- 仅将平台 `mentions` 确认的正文 @ 标签拆为消息段，避免 `#禁言 <@用户>` 残留标签而无法匹配插件正则；未经平台确认的字面标签保留为普通文字。全量消息中的真实自身 @ 仍能标记 `atBot`。
- ICQQ 全局 `segment.at` 原先会把字符串身份变为 0，本次只在 QQBot 事件的异步上下文中保留字符串 ID；其他账号使用原构造器，停用时恢复。

## 业务插件兼容

第三方插件可能把身份强制转成数字，或依赖官方平台未提供的历史字段。此类调用需按其版本适配，不能将缺失信息当作执行成员管理操作的依据。

[`scripts/prepare-yenai-group-patch.mjs`](../scripts/prepare-yenai-group-patch.mjs) 提供带固定输入 SHA256 的兼容配方。先核对对应公开源码快照，不在版本未知的文件上自动套用。它不属于普通安装自动执行步骤。
