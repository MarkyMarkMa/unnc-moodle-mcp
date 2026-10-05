# 发布流程

个人运行与公开发布共用一个权威源码；课程名单、课件、manifest 和专用登录会话始终在仓库外。不要发布个人开发仓库的旧 Git 历史。

导出仅允许在有提交的 Git 源码维护 checkout 中运行。下载的源码 ZIP 没有 Git 历史，不能直接再次导出；请使用权威 Git checkout。公开测试使用自己的临时合成 Git 仓库，不依赖维护者个人 checkout、资料或路径。

1. 协调其他开发进程停止编辑，检查 `git status` 和 `git diff`，完成评审与测试并提交。
2. 在权威源码运行 `npm test`，然后 `npm run export-public -- /absolute/new-directory`。目标必须不存在。默认拒绝 Git 脏状态，包含未跟踪文件；不要通过删除已有改动来满足检查。
3. 导出是逐文件白名单。新增源码、测试、文档或 skill 必须先审查并加入 `PUBLIC_FILES`；未知 fixture 即使被 Git ignore，也不能静默导出。私有 verify-real 脚本明确排除。
4. 导出前自动扫描个人绝对路径、维护者已知课程/资源标记及典型凭据赋值；命中仅报告文件与类别，不打印匹配值。扫描不是完整隐私审计，必须人工复核课程记录、姓名、邮件、URL、截图与学校材料；不要用真实会话测试扫描器。
5. `release-source.json` 记录来源 Git commit、仓库相对源码目录、dirty 标志、Git 状态和各文件 SHA-256。哈希只用于证明快照内容，不能代替 Git 版本管理。脚本捕获文件后检查并发变更，但不能代替发布时暂停编辑。
6. 在干净导出目录独立运行 `npm ci`、`npm test`，验证空配置标准 MCP stdio 工具发现与输入错误；需要 Chrome 的测试应在支持环境执行。不要复制个人数据来使测试通过。
7. 核对 `release-source.json` 的 `dirty=false`、`finalCandidate=true`，并再次与权威提交比对。独立初始化公开 Git 仓库或将这次导出的文件差异提交到已有公开仓库；保留公开仓库自己的历史，不合并个人旧历史。
8. 只从最终公开提交生成源码 ZIP，检查压缩包目录和隐私标记。构建目录、node_modules、凭据、个人配置和下载资料均不进入源码 ZIP。上传 GitHub 前按用户授权范围执行。

`--allow-dirty` 仅供隔离测试或非最终候选；产物明确记为 `finalCandidate=false`。来源 commit 只是候选的基底，实际内容以文件清单为准，不能将此候选当作已提交公开发布。最终包必须在整合完毕、权威源码干净后重新导出；不要复用旧候选 ZIP。

后续 bug 修复先进入权威源码，跑测试并提交，再向新目录导出，审查与公开仓库的 Git diff。公开导出不会自动将修复同步到另一仓库。

## 每次发布都必须保留的安装与升级入口

README 默认使用英文，顶部提供中文文档切换；两种语言保持 Installation/安装、Update/更新两个入口，不按版本细分用户。老用户统一运行 npm run update；太旧没有命令或无法直接升级时，保留资料与设置后重装。下载链接指向 releases 列表，不写死当前版本，也不依赖跳过 prerelease 的 releases/latest。保持原安装路径和既有设置；需要迁移或不兼容变化时，在 README 和 Release 正文提供具体步骤，不宣称无需操作。

每次发布还需：

1. 运行完整测试，验证旧版入口、新版 npm run update、资料保留和失败回滚的相关反例。变更更新器时，在隔离 ZIP 安装目录实测旧版升级；不对个人资料目录做更新实验。
2. Release 必须上传名为 unnc-moodle-mcp-vX.Y.Z.zip 的公开附件，前缀为 unnc-moodle-mcp/，含已提交来源的 release-source.json。版本必须与 package.json 一致；GitHub 资产必须提供 SHA-256 digest，否则现有更新器会拒绝。
3. Release 正文开头链接英文 README 与中文文档的 installation/update 锚点，只提示新用户下载和老用户 npm run update；不支持直接升级的旧版按 README 保留资料后重装。首次用户仍需本人登录/授权，已有用户更新后重新连接 MCP。
4. 上传后使用隔离旧版安装跑公开更新入口，核对获取的是刚发布版本、资料哨兵和原路径保留，再运行 npm run update 确认最新版不重复更新。若验证失败，修复后重新发布，不把上传成功当作升级成功。
5. 发布流程和更新器发生变化时，同步修订 README、skill、测试与白名单；避免只在聊天记录提供用户操作步骤。

这些检查保证发布交付包含可验证的升级路径；不承诺未知网络、未来平台或未来不兼容版本能无需干预运行。

英文 README 与 docs/README.zh.md、使用指南 docs/USAGE.md 与 docs/USAGE.zh.md 必须保持命令、支持范围和升级步骤一致。中文入口放在 docs/ 下，兼容 0.4.2 更新器的已有文件清单规则；不要未经兼容验证新增根目录发布文件。

## 项目展示与文档风格参考

持续参考 [Magenta CLI](https://github.com/Minions-Land/Magenta-CLI) 的安装/更新信息结构，以及 [Levis](https://github.com/CatVinci-Studio/Levis) 的英文首页与语言切换设计。项目说明采用正式、简洁的措辞；安装与更新保持两个主要入口；中英文内容同步维护。参考项目用于指导表达与组织，不应据此宣称本项目具备尚未实现或验证的功能。

Windows 实验性预发布仍使用与 package.json 一致的数字版本号，并设置 GitHub Pre-release 标志。正文必须说明真实 Windows 验证状态、setup.cmd 入口和手动升级限制。现有 macOS 更新器会选择数字预发布版，不得宣称现有用户不会收到该更新。Windows 自动升级不属于本次支持范围。

0.4.5 管理目录变更：发布说明必须提示升级前停止旧 MCP/CLI，首次启动迁移 state、默认 courses.json 及识别到的旧升级备份到 _moodle。跨平台共用实现，Windows 仍为实验性；跨根目录搬家仍需手动保留完整数据。

0.4.6：设置末尾提供推荐的 skill 安装选项；发布说明包含老用户 npm run install-skill 补装及程序更新不替换独立 skill 的限制。安装器与其测试进入公开白名单。

0.4.7：Windows 改为 Edge，登录、同步、doctor 与 DOM 测试一致；旧 Chrome profile 不导入不删除，需重新登录。显式 profile 覆盖使用新 Edge 目录。仍为未实测的 Windows 实验性预发布。

0.4.8：两种目录模式、持久分类规则以及单文件 Moodle 标题命名统一交付。升级前停止旧进程，重连新版并回读 organization；用 organize 整理已有未修改可读副本，保留批注和历史。公开包包含 routing 源码及相关反例，不包含用户目录映射、真实课件、课程记录和本地整理报告。Windows Edge 继续保持实验性，不将本次 macOS 验证算作 Windows 实测。

0.4.9：新增 login MCP 工具，由助手启动专用浏览器、用户本人完成登录/MFA。旧客户端保留 CLI 备用入口。升级后重连 MCP 才获得新工具；旧独立 skill 不自动替换，需备份并更新旧 skill，避免旧规则继续要求手动运行终端命令。
