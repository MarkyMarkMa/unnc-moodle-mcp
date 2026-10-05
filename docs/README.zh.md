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

**运行环境：** macOS、Google Chrome、[Node.js 24+](https://nodejs.org/)。本项目为面向 UNNC / Nottingham Moodle 的非官方工具，仅支持手动同步；Windows 与其他 Moodle 站点尚未验证。

<a id="installation"></a>

## 安装

1. 从 [Releases](https://github.com/MarkyMarkMa/unnc-moodle-mcp/releases) 下载版本号最高的 ZIP 附件，解压至固定的程序目录。
2. 打开 `scripts/setup.command`。安装入口检查运行环境，经确认后安装依赖、编译服务并启动设置向导。
3. 在专用浏览器中登录 Moodle、完成 MFA，选择课程并确认资料保存目录。
4. 按[接入 Codex](#接入-codex)完成配置，随后重启 Codex。

也可在解压后的程序目录中运行：

```sh
npm run doctor
npm ci
npm run build
npm run setup
```

设置向导不下载课件。接入完成后，可在 Codex 中输入：

> 检查 Moodle 连接与设置，然后同步我已选择的课程。

<a id="update"></a>

## 更新

在现有程序目录中运行：

```sh
npm run update
```

更新器获取最新已发布版本，在安装依赖与编译成功后替换现有程序。安装路径、设置、登录会话和已下载资料均予以保留；替换失败时恢复旧程序。

更新后重新连接 Moodle MCP 或重启 Codex，即可继续同步。

**旧版本重装：** 若 `npm run update` 不可用，或当前版本不支持直接升级，请停止旧 MCP 服务，按上述安装步骤重装。保留资料目录、`state`、`courses.json` 与现有设置，仅移除程序文件。若程序与资料共用目录，须先将资料单独备份。建议使用原程序路径；路径变化时需更新 MCP 配置。已有资料无需重新下载。

更新器适用于 ZIP 安装；Git checkout 应通过 Git 更新。版本选择包含公开预发布版，不包含草稿。网络异常时应在恢复连接后重试。

## 接入 Codex

在程序目录中运行：

```sh
npm run codex-config
```

将输出的 `[mcp_servers.moodle_local]` 区块加入 Codex MCP 配置，保留其他服务配置。此命令仅打印配置，不修改配置文件。服务入口为 `node /absolute/project/dist/src/server.js`。

可选安装附带 skill：将 `skills/unnc-moodle` 复制到 `~/.codex/skills/unnc-moodle`；自定义 `CODEX_HOME` 时使用其 skills 目录。替换已有 skill 前应检查差异。附带 skill 的说明为中文，MCP 工具可处理英文或中文请求。

重启 Codex 后检查 `get_sync_settings` 与 `check_connection`。下载前必须确认保存目录并选择课程。登录过期时运行 `npm run login`，由用户本人完成认证。

## 使用

| 操作 | Codex 请求示例 |
|---|---|
| 同步课程资料 | “同步我已选择的 Moodle 课程。” |
| 下载新增资料 | “快速同步 Moodle 课程资料。” |
| 整理已有资料 | “整理已有 Moodle 资料，不重新下载。” |
| 添加课程 | “显示 Moodle 课程列表，供我选择新增同步课程。” |

日常资料位于 `materials/课程名称/Moodle 分区/文件名`，历史版本保存在 `materials/.history`。程序不推断或翻译教学分类；批注文件与个人笔记予以保留。

快速同步发现新增文件，不检查已记录文件的远端更新；完整同步检查内容更新；整理模式仅维护本地目录，不下载资料。新增课程须经用户确认。

## 文档

- [使用、存储与故障排查](USAGE.zh.md) · [English](USAGE.md)
- [测试范围与限制](TESTING.md)
- [发布流程](RELEASE.md)

服务仅读取已选择且账户有权访问的课程，不提交作业、发送消息或修改学校内容。认证使用专用浏览器，由用户本人输入密码与 MFA 验证码。登录会话、下载资料和个人课程配置不得提交至公开仓库。

## 许可证

[MIT](../LICENSE)。许可证仅覆盖本项目代码，不授予学校课件、品牌或第三方内容的使用权。
