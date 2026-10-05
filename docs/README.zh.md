<h1 align="center">UNNC Moodle MCP</h1>

<p align="center">
  在 Codex 中下载与更新 Nottingham Moodle 课程资料的本地 MCP 服务。
</p>

<p align="center">
  <a href="https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases"><strong>下载</strong></a> ·
  <a href="#installation">安装</a> ·
  <a href="#update">更新</a> ·
  <a href="../README.md">English</a>
</p>

## 项目简介

下载已选课程的资料，按课程与 Moodle 分区组织，并通过 Codex 执行增量同步。历史版本与本地批注均予以保留。

**运行环境：** macOS + Google Chrome，或实验性 Windows + Microsoft Edge，以及[Node.js 24+](https://nodejs.org/)。本项目为面向 UNNC / Nottingham Moodle 的非官方工具，仅支持手动同步；Windows + Edge 已加入实验性适配，仍待真实验证；其他 Moodle 站点尚未验证。

<a id="installation"></a>

## 安装

### To human

1. 从 [Releases](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases) 下载版本号最高的 ZIP 附件，解压至固定的程序目录。
2. macOS 打开 `scripts/setup.command`；Windows 打开 `scripts/setup.cmd`（实验性）。安装入口检查运行环境，经确认后安装依赖、编译服务并启动设置向导。
3. 在专用浏览器中登录 Moodle、完成 MFA，选择课程及保存方式：自动按课程/栏目建目录，或沿用已有文件夹。末尾推荐安装 Codex skill，按回车接受，输入 n 跳过。
4. 按[接入 Codex](#接入-codex)完成配置，随后重启 Codex，按[使用](#使用)中的对应分支开始。

设置向导不下载课件。沿用已有文件夹时，先在 Codex 中确认分类规则，再下载未分类资料。

### To agent

在解压后的程序目录中打开 Codex，发送：

> 请帮我安装并接入这个 UNNC Moodle MCP。先阅读 README、检查环境，安装项目依赖及附带的 skill，保留我已有的 Codex 配置。课程和保存方式由我选择，Moodle 登录与 MFA 由我亲自完成。修改 MCP 配置前先展示具体变更让我确认；确认课程、目录及分类规则前，不要开始下载。

给 agent 的操作说明：先定位用户下载的项目；尚未下载时，引导用户按上方步骤下载 ZIP。检查 Node.js 24+ 和对应浏览器，获得安装授权后在程序目录运行：

```sh
npm run doctor
npm ci
npm run build
```

让用户在交互终端运行 `npm run setup`，亲自完成登录/MFA，并说明[使用](#使用)中的两种保存方式。除非用户选择跳过，应包含 skill 安装；向导已跳过且用户授权安装时，执行 `npm run install-skill -- --yes` 并检查结果，不覆盖冲突的现有 skill。随后单独完成[接入 Codex](#接入-codex)，保留其他 MCP 配置；安装 skill 不等于接入 MCP。重启 Codex 后回读设置和登录状态，再按用户确认的范围同步。

<a id="update"></a>

## 更新

在现有程序目录中运行：

```sh
npm run update
```

更新器获取最新已发布版本，在安装依赖与编译成功后替换现有程序。安装路径、设置、登录会话和已下载资料均予以保留；替换失败时恢复旧程序。

更新前停止所有旧 Moodle MCP/CLI 进程。0.4.5 首次启动会将旧管理文件收进与 `materials` 并列的 `_moodle`，详见[目录迁移与恢复](USAGE.zh.md#管理目录升级)。更新后重新连接 Moodle MCP 或重启 Codex，即可继续同步。程序更新保留独立安装的 skill；此前跳过安装的用户可补运行 `npm run install-skill`。

**旧版本重装：** 若 `npm run update` 不可用，或当前版本不支持直接升级，请停止旧 MCP 服务，按上述安装步骤重装。保留资料目录、`_moodle`（旧版为 `state`、`courses.json`）与现有设置，仅移除程序文件。若程序与资料共用目录，须先将资料单独备份。建议使用原程序路径；路径变化时需更新 MCP 配置。已有资料无需重新下载。

更新器适用于 ZIP 安装；Git checkout 应通过 Git 更新。版本选择包含公开预发布版，不包含草稿。网络异常时应在恢复连接后重试。

## 接入 Codex

在程序目录中运行：

```sh
npm run codex-config
```

将输出的 `[mcp_servers.moodle_local]` 区块加入 Codex MCP 配置，保留其他服务配置。此命令仅打印配置，不修改配置文件。服务入口为 `node /absolute/project/dist/src/server.js`。

macOS 和 Windows 设置向导均提供推荐的 skill 安装选项；老用户也可单独运行 `npm run install-skill`，无需重新登录学校。默认安装到 `~/.agents/skills/unnc-moodle`；已有旧 `~/.codex/skills/unnc-moodle` 时复用其位置；配置 `CODEX_HOME` 时安装到其 `skills/unnc-moodle`。相同版本不重复安装，不同或不安全的现有 skill 不覆盖；请先备份到技能目录之外并核对差异。skill 冲突不会撤销已完成的 MCP 设置。附带 skill 的说明为中文，MCP 工具可处理英文或中文请求。

重启 Codex 后检查 `get_sync_settings` 与 `check_connection`。下载前必须确认保存目录并选择课程。登录过期时运行 `npm run login`，由用户本人完成认证。

## 使用

选择以下一种保存方式。新用户在设置向导中选择；已安装的用户也可直接让 Codex 切换，无需重新安装。

### 1. 自动建立课程文件夹

设置时选择按课程/Moodle 栏目自动建目录，然后在 Codex 中输入：

> 检查 Moodle 连接与设置，按课程和栏目自动建目录，同步我已选择的课程。

资料保存为 `materials/课程名称/Moodle 分区/资源标题.扩展名`。单文件课件使用 Moodle 标题，例如 `Seminar 1.pdf` 和 `Seminar 1 (Solutions).pdf`；文件夹资源内部保留原文件名及层级。

### 2. 沿用已有分类文件夹

设置时选择合并到已有分类文件夹，填入各课程文件夹共同的根目录。已安装的用户可直接在 Codex 中输入：

> 我已经有自己的课程资料文件夹，位置是「粘贴文件夹路径」。请沿用里面的结构，把 lecture 放进 Lecture，seminar 放进 Seminar。先查看目录和已选 Moodle 课程的资源，给我展示分类建议；我确认后再保存规则和下载。保留已有文件和笔记。

Codex 查看实际资源标题、可用页面描述，以及你授权查看的本地目录。首次确认或纠正对应关系后保存规则，后续同步和重启继续沿用；同一个 Moodle 栏目里的不同资源也能分别归类。新资料未匹配或分类冲突时跳过并询问；首次分类成功后，资源改名仍留在原分类。纠正分类时确认具体资源归属。

目标文件夹须已存在于共同根目录下；移动后会报告失败，需要更新规则。分类依据是你确认的关键词或具体资源，不凭页面顺序、文件类型猜测，也不读取 PDF 内容自动分类。已有目录模式最初没有规则，未分类资料不会下载。

**已有文件不会自动接管或去重。** 新下载遇到同名文件时另存并加序号，可能留下重复文件，但原文件、笔记及批注会保留。切换输出根目录不迁移旧资料，历史版本仍保存在原 `materials/.history`。

任一模式配置好后，都可以使用以下请求：

| 操作 | Codex 请求示例 |
|---|---|
| 同步课程资料 | “同步我已选择的 Moodle 课程。” |
| 下载新增资料 | “快速同步 Moodle 课程资料。” |
| 整理已有资料 | “整理已有 Moodle 资料，不重新下载。” |
| 添加课程 | “显示 Moodle 课程列表，供我选择新增同步课程。” |

快速同步发现新增文件，不检查已记录文件的远端更新；完整同步检查内容更新；整理模式维护已跟踪的本地副本，不下载资料，可按 Moodle 标题重新命名旧版未修改课件，批注版独立保留。新增课程须经用户确认；有失败或跳过项时，不应将同步视为全部完成。

资料根目录通常包含 `materials` 和 `_moodle`：课程配置、同步状态、分类规则及识别到的旧升级备份统一放入 `_moodle`，保持可见以方便恢复。升级前停止旧 MCP/CLI，升级后重连并回读设置。

## 文档

- [使用、存储与故障排查](USAGE.zh.md) · [English](USAGE.md)
- [测试范围与限制](TESTING.md)
- [发布流程](RELEASE.md)

服务仅读取已选择且账户有权访问的课程，不提交作业、发送消息或修改学校内容。认证使用专用浏览器，由用户本人输入密码与 MFA 验证码。登录会话、下载资料和个人课程配置不得提交至公开仓库。

## 风格参考

本项目的文档与展示风格参考以下项目：

- [Magenta CLI](https://github.com/Minions-Land/Magenta-CLI)：明确区分安装与更新，突出主要命令，提供可执行的升级说明。
- [Levis](https://github.com/CatVinci-Studio/Levis)：英文默认首页、清晰的语言切换入口、简洁的项目介绍与一致的多语言文档。

后续文档修改应延续这些规范：表述正式、简洁；保留安装与更新两个主要入口；中英文操作说明保持一致。命令与支持范围应以本项目已验证的实现为准。

## 许可证

[MIT](../LICENSE)。许可证仅覆盖本项目代码，不授予学校课件、品牌或第三方内容的使用权。

## Windows（实验性）

Windows 安装、配置目录、权限与手动升级说明见[项目说明](../README.md#windows-experimental)。尚未完成真实 Windows 验证，不能承诺完整支持；自动升级仍仅适用于 macOS。

Windows 默认使用 Microsoft Edge，专用目录为 `%LOCALAPPDATA%/moodle-mcp/edge-profile`。旧 Windows Chrome profile 保留但不导入，需本人重新登录；课程和资料不变。显式设置 MOODLE_PROFILE_DIR 时请使用新的 Edge 专用目录。macOS 保持 Chrome。
