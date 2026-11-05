# 身份、数据关联与权限

QQ 官方平台的 OpenID 与普通 QQ 号码不是同一种标识。身份按 AppID 和群聊/C2C 场景隔离；未经核实，不根据聊天正文、公开游戏 UID 或昵称推断号码归属。

- 未关联用户使用 `qqbot:<AppID>:group-user:<OpenID>` 或 `qqbot:<AppID>:c2c-user:<OpenID>`。
- 可信管理员可通过 `userIdMappings` 将完整平台主体关联到既有数据归属字符串。业务读取使用关联标识，出站仍还原为对应平台 OpenID。
- 群聊关联不自动授予 C2C 身份，跨 AppID 不共享反向映射，同一场景下有歧义的映射拒绝加载。
- 主人权限独立按原始 OpenID 授权；关联到宿主主人号码不会提升权限。适配器不提供聊天自报号码自动绑定。

## 离线迁移工具

[`scripts/migrate-user-mappings.py`](../scripts/migrate-user-mappings.py) 默认只读审计。它以完整、非空的既有绑定与角色集合一致且候选唯一作为关联依据；存在歧义或证据不足时保持独立。

写入或回滚需显式传入 `--offline` 和 `--rollback-dir`，并在机器人停止后执行。工具保留新旧身份、已有抽卡记录及较新登录信息，为实际变更文件保留最小回滚材料。回滚先验证目标仍是本次写入的版本，拒绝覆盖后续更新。

```sh
python scripts/migrate-user-mappings.py --help
python scripts/migrate-user-mappings.py --root <云崽目录>
```

运行输出只提供统计和固定错误码。迁移材料可能包含用户数据，应保存在受限目录内，不提交版本控制或复制到公开报告。该工具不是 QQ 号所有权认证系统。
