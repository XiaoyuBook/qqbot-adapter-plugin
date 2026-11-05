# 来源、版本与许可核查

核查日期：2026-11-02。适配器产品代码独立编写，没有复制以下参考插件的源码、使用其私有模块、修改 SDK 原型或引入其 HTTP/OneBot 入口。本项目尚未选定开源许可证，暂为 `UNLICENSED`；第三方项目的许可不因此改变。

## 参考项目

| 来源与固定提交 | 核查结果 | 设计参考及采用范围 |
| --- | --- | --- |
| [Pimeng/QQBot-plugin](https://github.com/Pimeng/QQBot-plugin/tree/d33f347f57d9474c8be680da5aa488b1e6267065) | package 1.0.0；LICENSE / package 标注 GPL-3.0；运行 SDK qq-official-bot 1.3.0 | 核查 accounts、Miao 事件与账号约定。采用分层思路；不用其全局 Bot 包装、身份绑定、SDK 补丁或产品源码 |
| [win-syswow64/Lain-plugin](https://github.com/win-syswow64/Lain-plugin/tree/d7af609600f7f14fd107de2cf611af9d56ed2250) | package 1.5.6；LICENSE GPLv3；QQBot adapter 0.0.3；qq-group-bot 1.1.0 | 核查 QQSDK、场景订阅与连接模式；不用其多平台入口、服务器、映射命令或源码 |
| [TimeRainStarSky/Yunzai-QQBot-Plugin](https://github.com/TimeRainStarSky/Yunzai-QQBot-Plugin/tree/60a2e87d82aef2940e2b6d299f2ae2b45519fd4b) | package 未标版号/许可证；该提交树未发现 LICENSE；依赖 qq-group-bot 1.1.0 | 核查入口、TRSS Bot.uin/adapter/em 接口差异；未据此推定有复制许可，不复制代码 |
| [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai/tree/354b806102f43cb5a216e8e2418b57278246fdb2) | 3.1.3；GPL-3.0 | 目标宿主实际接口；测试时从固定公开提交/本地快照载入，校验 SHA256。可选结果导航迁移只保存两文件的带校验修复配方，不分发第三方源文件 |
| [qiannqq/napcat-adapter](https://github.com/qiannqq/napcat-adapter/tree/4310237a7ff1bafd6531e09400ebc7e11225343f) | package 1.0.0；GPL-3.0 | 测试实际 BotInit/dealEvent 方法；不修改生产适配器 |
| [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin/tree/eab9cb27c0a4af105307568a84fee33ba6413b95) | 核查 guoba.support.js、IPluginService 和 Result 接口 | 兼容 supportGuoba 的 schema、getConfigData、setConfigData/Result 契约，不复制实现；页面行为需要单独验收 |
| [Ctrlcvs/xiaoyao-cvs-plugin](https://github.com/ctrlcvs/xiaoyao-cvs-plugin/tree/e7ab3e8b276a11680beb47d0c5517f6e0a4c2022) | 来源 cnb.cool/tar/xiaoyao-cvs-plugin；LICENSE GPLv3；固定提交源码及 SHA256 已核查 | 隔离执行实际扫码应用、Common.render、延时撤回辅助函数；测试源码只在忽略的缓存中。两处扫码状态日志补丁保留上游许可，未复制为适配器产品源码 |
| [yenai-plugin](https://gitee.com/yeyang52/yenai-plugin) | 公开源码快照 package 2.0.0、GPL-3.0；目录没有独立 Git 元数据，逐文件 SHA256 固定于 test/host/yenai-manifest.json | 执行实际群管应用、模型及权限检查；适配器仅保存带校验的三文件修复配方，第三方源文件保留上游许可与其他已有修复。原始源码只在忽略的测试缓存中 |

宿主/NapCat 测试源码只存放在被 Git 忽略的 `.verification-cache`，不进入产品发布清单或本仓库提交。`test/host/manifest.json` 保存来源、固定提交和校验值。后续若决定复制、修改或分发第三方代码，应单独保留其版权、完整许可及相应源码义务；当前不能因为“参考”而假定允许任意复制。

## 官方协议与 SDK

- [tencent-connect/bot-docs](https://github.com/tencent-connect/bot-docs)：仓库 MIT；核查 WebSocket Opcode / close code、`1 << 25` 意图、群 @ / C2C 字段、v2 被动消息和富媒体接口。
- [腾讯官方 Node SDK](https://github.com/tencent-connect/qqbot-nodejs/tree/429a0f1b798f3b0fcef3679e207dbc0469a1df2d)：核查时 package 1.0.5、MIT、Node >=20；可用 HTTP+WS。核查 token、ApiClient、media、messages、gateway/constants/connection 的当前接口。

本版采用原生 fetch + `ws`，直接实现少量官方协议，不依赖未核实的社区 SDK。这样能明确控制 ACK 看门狗、只订阅群/C2C、禁止上游响应和消息内容进入日志，以及保守的发送重试语义。新官方 SDK 默认日志路径会包含报文，网关实现未在所核查路径中执行心跳 ACK 超时重连；这里不直接复用或打补丁。该选择不表示官方 SDK 不可使用，后续迁移须重新核验这些行为。

**资料差异必须保留：** 旧富媒体文档的 `file_data` 标为未支持，1.0.5 官方 SDK 的 media 模块已经使用 base64 上传；本实现覆盖该报文，但是否可用仍以用户账号实测为准。主动消息受账号和场景权限限制，适配器仅在本地显式允许且目标已观察时尝试，不由本地开关赋予平台权限。WebSocket 准入可能因账号/平台策略不同而变化，不能从源码存在推断账号拥有接入权限。

## 安装依赖

| 依赖 | 固定直接版本 | 许可与用途 |
| --- | --- | --- |
| ws | 8.22.1 | MIT，WebSocket 连接；独立 lockfile 固定完整性与传递依赖 |
| image-size | 2.0.4 | MIT，读取图片尺寸及 JPEG EXIF 方向，用于 QQ Markdown 图片排版；不解码像素、不下载远程图片 |
| icqq | 0.6.10 | MPL-2.0，仅开发测试，执行真实 Client/TripTrap 事件总线；npm 已标记停止维护，与目标宿主版本一致 |
| lodash | 4.18.1 | MIT，仅宿主隔离测试 |
| moment | 2.30.1 | MIT，仅宿主隔离测试 |

使用 `npm ci --ignore-scripts`，生产使用 `--omit=dev`，无需修改宿主根 package.json 或锁文件。完整解析版本、tarball 来源和 integrity 见 `package-lock.json`。依赖许可证随各安装包提供，不能将测试依赖误认为产品运行依赖。运行依赖审计的时间和范围见验证记录。
