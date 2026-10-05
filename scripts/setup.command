#!/bin/zsh
set -eu
cd -- "${0:A:h:h}"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print '请先安装 Node.js 24 或更新版本（包含 npm）：https://nodejs.org/'
  read -r '?按回车关闭'
  exit 1
fi
node scripts/doctor.mjs || { read -r '?按回车关闭'; exit 1; }
print '此向导将安装本项目 npm 依赖并编译，不修改全局 Codex 配置。'
read -r 'answer?继续？输入 yes：'
[[ "$answer" == yes ]] || exit 0
npm ci
npm run build
npm run setup
print '下一步：将以下区块按 README 加入 Codex 配置，并安装附带 skill：'
npm run codex-config
read -r '?按回车关闭'
