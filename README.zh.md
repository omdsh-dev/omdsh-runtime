# OMDSH Runtime

一个复用官方 Harness Profile、Bundle、Cordis 与包操作的无前端执行层。它只补确定性的 plan/apply、candidate generation、用户确认和 previous generation 恢复，不新增第二套 Loader 或 daemon；DSH Hub Workshop 始终是唯一发现、作者发布、审核与 feed 主数据源。

源码仓库已公开。`@ohmydsh/runtime` 配置为 npm 公开预览包，只使用 `preview` dist-tag，预览版本不会隐式移动 `latest`。

代码边界保持为“一个 Toolkit 仓库、多个稳定模块”：`profile-pack` 只负责格式、内容摘要、签名和组合检查；`pack-authoring` 只负责作者清单；`license` 只负责 SPDX 事实；`pack-instances` 只负责命名实例；CLI 只是调用这些模块和既有 Runtime/官方 DSH 操作的薄层。Hub 不 import Runtime 源码，双方只交换带版本的 JSON Schema、Registry 快照 ID、锁包和签名结果。等第三方确实需要独立依赖时，可以原样发布这些子路径或拆成 `pack-core` 包，不需要改 Pack 格式或 CLI。

## 可移植 Profile Pack

`omdsh-profile-pack/v1` 是轻量、可审查的 JSON 发行格式。它只记录固定的 Registry 项目与 Release ID、固定到完整 Git commit 的自有源码、Registry 快照、实际观测到的 `@deepseek-ai/dsh` 版本，以及一个 Agent Preset；不会复制插件包体、凭据、会话、环境文件或本机绝对路径。

```sh
# 新建整合包：既可加入已准入 Release，也可加入自己的固定源码插件。
omdsh pack init research.pack.json --id research --preset code
omdsh pack add research.pack.json --release sample@1.2.3
omdsh pack add research.pack.json --source-id my-plugin --package @me/dsh-my-plugin --version 0.1.0 --repository https://github.com/me/dsh-my-plugin --ref <40位完整commit> --license MIT

# 先查看所有组件许可证，再绑定 Runtime、Registry、哈希与来源并试跑。
omdsh pack licenses research.pack.json
omdsh pack lock research.pack.json --output research-0.1.0.dshpack
omdsh pack test research.pack.json --profile web --trust-source

# 导出当前受管理 Profile，并引用一个官方预设。
omdsh pack export --profile web --preset standard --output web-0.1.0.dshpack

# 把 Workshop 生成的发行清单绑定到当前 Runtime 与 Registry。
omdsh pack build research-0.1.0.distribution.json --output research-0.1.0.dshpack

# 只读检查 schema、文件哈希和整包 digest，再对当前 Runtime、Registry、Profile 与信任参数做零 Profile 写入预检。
omdsh pack inspect research-0.1.0.dshpack
omdsh pack plan research-0.1.0.dshpack --profile web --trust-source

# 用 Ed25519 绑定发布者来源，再显式传入可信公钥验证。
omdsh pack sign research-0.1.0.dshpack --private-key publisher.pem --key-id example/releases-2026 --publisher example --source https://github.com/example/research --output research-0.1.0.signed.dshpack
omdsh pack inspect research-0.1.0.signed.dshpack --trusted-key publisher.pub

# 在命名实例中只生成 candidate；激活仍然是独立动作。
omdsh pack apply research-0.1.0.signed.dshpack --instance research --profile web --trusted-key publisher.pub --require-signature
omdsh activate --profile web
omdsh confirm --profile web
omdsh pack instance research

# 先看版本差异，再准备更新；回滚会重新选择上一个 Profile generation。
omdsh pack diff research-0.2.0.signed.dshpack --instance research
omdsh pack update research-0.2.0.signed.dshpack --instance research --trusted-key publisher.pub --require-signature
omdsh pack rollback --instance research
```

源清单刻意保持很小：有序组件清单、一个内置预设、SPDX 许可证表达式和不可变来源。分支、浮动标签、本地路径、安装脚本、密钥和复制的 `node_modules` 都不会被接受。`pack licenses` 会列出每个组件的许可证表达式、声明来源、SPDX 链接及人工核对提醒；它是可信事实清单，不是法律意见，也不会替作者自动判断许可证兼容性。

已准入 Registry Release 沿用原有信任；作者自己的源码始终标记为 `experimental-fixed-source`，生成 candidate 前必须显式传入 `--trust-source`，完成插件 Registry 准入前不能作为可信社区发行。整合包若只引用已经准入的 Release，不重复每个插件的人审，只做组合检查并对最终 digest 签一次。

内置预设 `standard`、`code`、`minimal`、`cordis` 只引用官方 Harness 中的 ID。自定义预设仅嵌入 UTF-8 文本，并拒绝符号链接、疑似凭据的文件或内容、二进制数据和本机绝对路径。应用嵌入内容必须显式传入 `--trust-preset`；覆盖已有自定义预设还必须传入 `--replace-preset`。

应用整合包时，只会替换当前固定 Registry 快照所管理的插件，以及同一命名整合包实例明确跟踪的固定源码；其他未纳管本地包保持不变。生成的 candidate 仍需单独激活并完成运行确认，原有 previous-generation 恢复流程不变。

它和工作区型 Pack/Skill 投影工具可以共存：后者适合把 Skills、提示词和编辑器配置映射进当前项目，并提供搜索或白名单；这里的 Profile Pack 聚焦可发行边界，固定 DSH Runtime、Registry Release、作者源码 commit、许可证、发布者签名和可回滚的 Profile generation。它不接管 Skill 搜索，也不把另一种 Pack 格式包装成 DSH 插件，因此不会形成第二套 Loader。

为兼容已有文件，未签名 v1 包仍可读取。带签名的 `omdsh-profile-pack-envelope/v1` 只有在传入发布者公钥且 Ed25519 校验通过后才可执行；`--require-signature` 可以拒绝旧的未签名输入。命名实例只保存包身份、精确 Release 选择、预设身份、发布者事实和 generation 指针。回滚不承诺撤销数据库、网络、文件系统等外部副作用，嵌入式预设的回滚也仍不属于 Profile generation。
