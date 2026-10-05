---
name: unnc-moodle
description: 在 Codex 中设置和使用 UNNC Moodle 资料同步 MCP，包括首次登录、选择课程、确认保存目录、手动同步及解释失败。适用于用户要求连接 UNNC Moodle、同步课件或更换学期课程。
---

使用已连接的 `moodle_local` MCP；如果名称不同，按工具描述识别。不要自己重新实现浏览器登录或下载。

## 未接入

先定位用户下载的公开项目和 README。项目提供 `scripts/setup.command`（macOS 双击入口）、`scripts/setup.cmd`（Windows 实验性入口）、`npm run setup` 和 `npm run doctor`。安装需要 Node.js 24+ 和 Google Chrome。说明将安装项目依赖；用户已授权安装时继续，否则确认。按 README 生成/填写 Codex 的 MCP 配置，修改全局配置前说明具体改动并保留现有配置。skill 本身不安装 MCP、不授权全局配置变更。

## 程序更新

用户要求更新时，定位实际安装入口和 README；ZIP 安装使用 npm run update，旧版首次升级用 README 的独立更新入口。保持安装路径、已有设置与资料，不要求重新选课。Git checkout 通过 Git 更新，不能用 ZIP 更新器替换源码历史。更新命令安装项目依赖，已有用户授权时继续；不修改全局配置或独立 skill。更新后重新连接 MCP/重启客户端，再回读设置和登录；用户只要求整理时调用 sync_courses mode: organize，不触发下载。

## 首次设置与换课

先调用 `get_sync_settings` 和 `check_connection`。返回 `authenticated: false`、`needsLogin: true` 或报 `NEEDS_LOGIN` 时，让用户在本地运行 `npm run login` 并亲自完成学校登录/MFA；不得索要密码、验证码、Cookie 或复制个人 Chrome。

调用 `list_courses`，把实际发现的课程名称展示给用户选择，不编造课程 ID、不自动选择所有课程。用户确认课程后调用 `select_courses`；它替换整个名单，增加课程时保留用户仍要同步的课程。空数组清空名单，不删除旧资料。

展示已选名称、当前资料根目录（materials 的上级目录）、保留旧版本、仅手动同步。用户确认这些设置后调用 `confirm_setup`，传当前根目录和 `confirmed: true`。用户已经明确批准相同设置时不要重复确认。工具强制检查设置与名单；不能仅因 skill 已加载就假定设置完成。

0.4.5 管理文件位于与 materials 并列的可见 _moodle：课程名单为 _moodle/courses.json，状态为 _moodle/state。升级前停止旧 MCP/CLI；首次启动迁移旧管理文件，不移动课件。外部名单/显式覆盖保持原位；冲突或中断标记须按使用指南恢复，不能删除 manifest 强行重试。

更换根目录使用 `npm run setup`，不把改路径说成迁移；迁移旧资料按 README 停止进程、备份和整体复制。CLI 改配置后重启现有 MCP，并回读设置。MCP `select_courses`/`confirm_setup` 更新当前进程，不要求为了换名单重启。

新增课程时先调用 list_courses 展示未选择课程，由用户明确选择后调用 select_courses 的 mode: add，保留现有名单；用户给出课程名称时先解析真实ID，不猜测，不自动批准所有新课程。

## 日常同步

回读设置与登录状态。设置已完成且名单非空时，按用户请求调用一次 `sync_courses`。用户要求快速或只下载新增时传 mode: quick；完整检查传 mode: full（默认）。快速模式的 skipped 是未检查旧文件，不能报告成“旧文件未变化”；提醒它不会发现远端旧文件替换，也不会重新下载损坏的本地历史文件；仍会维护可读目录。只整理目录时传 mode: organize，不下载课件。日常资料按英文课程名/Moodle 原始分区组织，历史在 materials/.history。新课程获批加入后，快速模式会下载它的所有未记录资料。部分失败只针对已发现的失败资源决定是否单独重试；下载已内置最多三次 NETWORK/PARSE_FAILED 尝试，预算耗尽后不要无限循环。

检查业务摘要里的 failed、needsLogin、stoppedReason，MCP 调用成功不等于同步成功。429 停止当前批次，告知稍后手动重试，不立即再次同步。LOCAL_IO 先解决磁盘/权限，INTERNAL 或持续解析失败报告具体阶段与尝试次数，不猜根因。

报告新增、更新、未变化、失败和跳过的数量；明确本次真正新增的文件与已存在的文件。指出保存位置，必要时给 Finder 的 ⌘⇧G 操作。保留旧版本，不删除或移动用户文件。外链只报告，不携带学校凭据访问。此项目不提交作业、发消息或修改学校数据。

## 范围

已验证 UNNC 的 Nottingham Moodle、macOS + Chrome；Windows + Chrome 有实验性适配但尚待真实验证，不宣称完整支持。Windows 暂用手动升级，不运行仅支持 macOS 的自动升级。标准 stdio 接入可供其他客户端评估，但不要宣称未验证的客户端、其他学校或平台已经兼容。不创建用户未要求的定时任务。
