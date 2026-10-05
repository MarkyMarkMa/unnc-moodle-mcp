# UNNC Moodle MCP + Codex skill

在 Codex 中说“同步我的 Moodle 课件”，把已选择课程的讲义保存到电脑，更新时保留旧版本。一个共享 MCP 核心、首次设置向导和薄的 Codex skill；个人课程、路径和会话在仓库外，不维护个人专属代码分叉。

**支持范围：UNNC 使用的 Nottingham Moodle、macOS + Google Chrome、Node.js 24+。** 非官方项目。只读访问学校数据，第一版仅手动同步。Windows、Edge、其他学校和其他 agent 客户端尚未验证。

## 从这里开始：安装或更新

### 新用户下载

打开 [发布下载页](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases)，下载最高版本号的 ZIP 附件，解压后双击 `scripts/setup.command`。按向导登录、选课，再按[新手开始](#新手开始)接入 Codex。

### 老用户更新

在原程序目录（含 `package.json` 的文件夹）运行：

```sh
npm run update
```

更新后重新连接 MCP 或重启 Codex，然后说：

> 检查 Moodle 登录和设置，然后同步我已选择的课程。

**旧版提示没有 update 命令，或无法直接升级时，重装最新版即可。** 先关闭旧 MCP，保留课件目录、`state`、`courses.json` 和原设置；只删除旧程序文件夹，再按“新用户下载”安装。尽量放回原程序路径，使用原资料目录与课程名单；路径改变时更新 Codex 的 MCP 程序路径。若资料与程序放在同一文件夹，先把资料和状态完整备份到别处，不能一起删除。无需重新下载已有课件。

不知道安装目录时，把[仓库链接](https://github.com/MarkyMarkMa/unnc-moodle-mcp)交给 Codex，说：“按 README 帮我更新 Moodle MCP，保留原设置与资料；太旧不能更新就帮我重装。”

## 新手开始

1. 安装 [Node.js 24 或更新版本](https://nodejs.org/)（包含 npm）与 Google Chrome。
2. 从[发布下载页](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases)下载最高版本号的发布版 ZIP 附件并解压，双击 `scripts/setup.command`。它检查环境，经你确认后安装本项目依赖、编译并打开设置向导；不会修改全局 Codex 配置。macOS 如果阻止脚本运行，可以采用下方终端方式，无需关闭系统安全功能。
3. 向导中选择资料根目录，在专用 Chrome 中亲自登录和完成 MFA，从真实课程名称列表中选课，再确认摘要。不要把密码、验证码或 Cookie 发给 AI。
4. 按下方说明接入 Codex，安装附带 skill，重启客户端后检查工具是否出现。

终端方式：打开项目目录，运行：

```sh
npm run doctor
npm ci
npm run build
npm run setup
```

向导不会自动下载。设置完成后运行 `npm run sync`，或在接入后的 Codex 中说“检查 Moodle 登录状态，然后同步我已选择的课程”。无需输入课程 ID；向导用课程序号选择。默认资料根目录 `~/Documents/MoodleSync`，可以改用其他绝对路径。

环境检查针对默认 `/Applications` 中的 Chrome；不是 Chrome 安装器。项目不自动安装 Node/Chrome，也不自动授权 Codex 修改配置。

## 接入 Codex

运行 `npm run codex-config` 可以打印已填好本机 Node 和服务路径的配置区块（复制从 `[mcp_servers.moodle_local]` 开始的部分，不包含 npm 提示）；它不会修改任何配置。仓库也提供 `codex-mcp.example.toml`。用 `command -v node` 找到 Node 绝对路径，填写它以及本项目 `dist/src/server.js` 的绝对路径。经你确认后将该区块加入自己的 Codex MCP 配置；先备份并保留其他服务。不要把凭据写进配置。重启客户端后调用 `get_sync_settings` 与 `check_connection`，核对实际目录、课程和登录状态。

安装 skill：把仓库里的 `skills/unnc-moodle` 整个目录复制到 `~/.codex/skills/unnc-moodle`（自定义 CODEX_HOME 时用其 skills 目录）。已有同名 skill 时先比较，不静默覆盖。重启后可以说：

> 使用 $unnc-moodle 帮我设置 Moodle，之后同步我选择的课件。

skill 负责引导，MCP 负责硬性检查。**未确认目录或名单为空时，下载与同步返回 SETUP_REQUIRED；检查连接、发现课程仍然可用。** 安装 skill 不等于安装/连接 MCP，也不能绕过设置门槛。

服务入口为 `node /absolute/project/dist/src/server.js`，使用标准 MCP stdio，stdout 只用于协议。官方 MCP Client 已测试工具发现与调用；没有实测 Claude/Cursor 等客户端，因此不承诺直接兼容。

## 一条命令更新

ZIP 安装用户在原程序目录运行：

```sh
npm run update
```

没有 update 命令的旧版按页面顶部[老用户更新](#老用户更新)中的重装步骤操作。

这条命令从本项目 GitHub 下载并执行更新脚本。更新器自动选择最高版本号的已发布版本（包括标记为 prerelease 的公开版本，不含草稿），校验 GitHub ZIP digest 与公开源码清单，在临时目录安装依赖和编译成功后才替换原位置的程序。不修改全局 Codex 配置、独立安装的 skill、课程名单、登录会话或资料；不会自动下载课件。原安装路径保留，通常无需改 MCP 配置。Git checkout 拒绝自动替换，请通过 Git 更新并重新安装/编译。

替换时禁止并发 Moodle 操作；正在同步时会停止更新，完成后重试。旧程序保留在终端打印的 `previous` 备份目录，替换失败自动回滚。强制结束进程或断电不保证自动恢复：保留 `.moodle-update-*` 目录与 `update.json`，核对其中的原安装路径和备份，恢复后再处理 `.moodle-update-lock` 和资料目录中的 `state/operation.lock`；不要在另一个更新或同步仍运行时删除锁。依赖安装失败不动旧程序。

更新完成后重新连接 Moodle MCP 或重启 Codex，然后直接说：

> 检查 Moodle 登录和设置，把已有资料整理成新版英文目录，不重新下载。

如果登录过期，由用户亲自完成登录/MFA；旧课程名单及设置继续使用，无需重新选课。之后每次更新都可使用 `npm run update`。

## 工具与常用命令

| 工具 | 用途 |
|---|---|
| get_sync_settings | 显示目录、课程、setupConfirmed、readyToSync 和下一步 |
| check_connection | 验证专用会话，不返回凭据 |
| list_courses | 从 My Modules 发现课程，包括隐藏课程 |
| select_courses(courseIds) | 经用户批准替换名单，拒绝未观察到的 ID；空数组清空名单 |
| confirm_setup(dataDir,confirmed:true) | 经用户确认当前根目录和名单后保存设置；不是迁移工具 |
| list_resources(courseId) | 列出已选课程资源及类型 |
| download_resource(courseId,moduleId) | 下载指定已发现文件/文件夹模块 |
| sync_courses(forceContentCheck?) | 对已批准名单执行一次增量同步 |

终端命令：`npm run settings` 查看设置、`npm run login` 重新登录、`npm run courses` 列课、`npm run select -- COURSE_ID ...` 替换名单、`npm run select -- --clear` 清空名单。CLI select 后其他已运行进程需重启；MCP select_courses/confirm_setup 更新当前进程。多个进程同时更改配置时，应停止旧进程并重新核对，避免旧快照继续工作。

下学期运行 `npm run setup` 重新选择课程即可，无需改源码。取消选择保留原有文件与历史，不再同步该课。已经登录时向导跳过重新登录。明确配置过相同设置时不用重复确认每次同步。

## 保存位置与迁移

持久设置默认 `~/Library/Application Support/moodle-mcp/settings.json`，向导在确认后记录所选根目录和课程配置路径。根目录下：

- `materials/`：日常资料，按 `英文课程名/Moodle 原始分区/文件名` 保存；Moodle 文件夹保留名称与内部子目录。未命名分区使用 `General`。
- `materials/.history/`：内部历史版本，资源 ID 与版本号只在这里出现。
- `state/`：增量状态、临时文件及操作锁。
- `courses.json`：课程白名单。

用 Finder 的 **⌘⇧G** 粘贴 `get_sync_settings` 中的 materials 路径查看。正常浏览无需进入 `.history`。同名文件用 `(2)` 等可读后缀区分，课程名采用已选课程名单中的名称；不会自动翻译课程或分区。内容校验不代替 Git 源码版本管理。

老师更新后，可读位置自动更新；旧版本留在 `.history`。可读文件与历史独立，macOS 支持时使用 copy-on-write，否则复制会占用额外空间。用户修改过的课件不会覆盖，远端最新版另存带后缀的文件；自行添加的笔记同样保留。分区改名时仅移动程序管理且未修改的可读文件。远端移除资料时本地仍保留。

升级到 0.4.1 后，运行 `npm run organize`（或 `sync_courses` 的 `mode: "organize"`）只读取课程/文件夹目录、整理已经下载的文件，不下载课件。旧编号目录逐文件迁入 `.history`，同步状态同时更新，空旧目录清理；中断后可重跑；若进程恰在可读文件发布与状态提交之间退出，可能留下未登记副本，下次会保守另存，避免误删用户文件。完整同步与快速同步也自动维护布局。整理需已有登录与确认设置，建议先备份 `materials` 和 `state`。

绝对路径环境变量可覆盖：`MOODLE_DATA_DIR`、`MOODLE_COURSES_FILE`、`MOODLE_SETTINGS_FILE`、`MOODLE_PROFILE_DIR`。名单与设置必须是各自专用的 JSON 文件，不能放入 materials、state 或浏览器 profile 内，不能指向同一文件。环境变量优先于持久设置；CLI 与 MCP 应使用一致的覆盖值。改变根目录或名单文件路径会要求重新确认，不能直接把旧确认用于新位置。`MOODLE_HEADLESS=false` 显示操作窗口。

**改根目录不等于自动迁移。** 要保留旧历史：停止 MCP/CLI、备份旧根目录，将 materials、state、courses.json 整体复制到一个新目录，保留旧目录，运行 setup 确认新根目录，重启 MCP 并回读设置。不要只复制课件而漏掉 manifest；不要在同步运行时迁移。项目没有自动迁移命令，未执行真实资料迁移测试。

从旧版本升级按页面顶部的入口操作。已有课程名单、资料和确认设置继续保留；仅在 `get_sync_settings` 显示未确认时核对原目录与课程后确认，不重复要求已设置用户跑完整首次向导。不要为升级重新下载全部资料，不要上传自己的数据目录。

## 快速同步与新增课程（0.4.0）

日常只找新增资料：`npm run sync:quick`，或对 Codex 说“快速同步 Moodle 课件”。MCP 调用 `sync_courses` 的 `mode: "quick"`；默认仍为 `full`，完整检查用 `npm run sync`。

快速模式读取已选课程列表，只下载 manifest 中没有记录的模块/文件，不请求旧文件的 ETag；维护可读目录时会读取本地文件并校验内容。已存在文件列入 skipped，不能说它们已经验证未变化。文件夹仍需读取其列表，以发现新文件及重试上次部分失败；已有文件内容不检查。快速模式不报告远端删除；历史文件完整时可以重建丢失的可读入口，但不重新下载丢失/损坏的历史文件；检查这些问题请运行完整模式。`--quick` / `--organize` 与 `--force` 不可同时使用。

第四门课或下学期课程：先 `npm run courses` 或调用 `list_courses` 查看真实课程，用户确认后执行 `npm run add -- COURSE_ID ...`，或 MCP `select_courses` 传 `mode: "add"`。它保留原名单，拒绝未发现ID。新课没有记录的资料将在下一次快速同步中全部下载。CLI添加后重启已运行MCP；MCP添加立即对当前进程生效。首次设置尚未确认时仍必须确认目录。

新发现课程不会未经用户批准自动下载：Codex展示未选择候选课程，经用户选择后添加。老师只是在已有课程新增课件模块时，不需重新批准课程。完整模式建议按需要定期运行，以发现旧课件替换。

## 同步结果与可靠性

每次结果包括 added、updated、unchanged、failed、skipped、remoteMissing；失败包含阶段与下载尝试次数。必须检查业务结果，MCP 返回文本成功不代表所有资源同步成功。

- 用资源 ID 与远端路径识别文件，用 SHA-256 比较内容。可靠 ETag 可条件请求；304 且本地校验一致才跳过。无验证器可能重复传输，但不重复保存相同内容。
- 更新新建版本，保留旧版与用户本地编辑；远端消失不删除本地文件。只有已确认发现完整的页面才标记缺失，无法确认时报告解析失败并保留历史。
- 下载阶段 NETWORK/PARSE_FAILED 最多三次，等待 1.5 秒、3 秒；持续失败仍报告，不猜链接。retryable 表示后续手动调用可能有意义，不表示自动无限重试。
- 任意阶段 429 立即停止整批，保留已成功项；登录过期也停止。权限不足或404只报告对应项/课程。LOCAL_IO 提示先解决磁盘或权限，INTERNAL 不冒充网络故障。
- 临时下载完成后才提交；成功摘要在状态保存成功后写入，失败清理临时状态文件。状态损坏停止，不重置历史。崩溃残留 operation.lock 仅在确认对应 PID 已停止后移除，不自动偷取锁。
- 显式导航和下载请求串行、间隔至少 1.5 秒；浏览器自身页面子资源/AJAX 不是所有请求均经过该间隔。下载上限 100 MiB，响应体缓存，不是严格流式内存限制。

文件与已发布文件夹可下载；论坛、测验、作业、反馈等非文件活动跳过。特殊插件、真实文件夹隐藏子树、视频、ZIP 展开不保证支持。HTML 讲义按文件保存，同步不执行脚本、不镜像外部资产；离线用浏览器打开后可能执行其原脚本并加载外部资源。

## 登录与数据边界

专用浏览器位于 `~/Library/Application Support/moodle-mcp/browser-profile`，不读取或复制日常 Chrome。目录700、会话600权限，只额外保存 Moodle 域 Cookie；整个专用 profile 可能有正常 SSO 缓存，应视为敏感。文件权限不等于加密。

NEEDS_LOGIN 时停止操作，运行 `npm run login` 亲自认证。关闭异常或 Chrome 缺失应结合 doctor 排查，PROFILE_BUSY 不能保证就是另一个进程占用。撤销时停止服务/专用窗口，删除本项目专用 profile，并按学校方式注销学校会话；删除本机文件不能保证撤销其他副本。不要删除个人 Chrome。

仅访问已选择、账户有权限的课程，不提交作业、发消息或修改学校内容。外链只报告，不携带学校凭据访问；登录窗口允许学校正常 SSO。访问会被网站正常记录。不要把 profile、会话、课程名单、课件或私有验证记录提交 GitHub。

## 验证与发布

运行 `npm test`。测试范围、真实证据和未验证项见 [docs/TESTING.md](docs/TESTING.md)。公开导出与审查步骤见 [docs/RELEASE.md](docs/RELEASE.md)。发布包包含同一套核心、向导、skill、测试与许可证，不包含个人仓库旧 Git 历史。

MIT 许可只覆盖本项目代码，不授予学校课件、品牌或第三方内容的权利。

参考：[MCP SDK](https://modelcontextprotocol.io/docs/sdk)、[Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)、[Codex MCP](https://developers.openai.com/codex/mcp)。
