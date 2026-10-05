@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 goto missing
where npm >nul 2>nul
if errorlevel 1 goto missing
node scripts/doctor.mjs
if errorlevel 1 goto failed
echo 此向导将安装本项目 npm 依赖并编译，不修改全局 Codex 配置。
set /p "answer=继续？输入 yes："
if not "%answer%"=="yes" goto done
call npm ci
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
call npm run setup
if errorlevel 1 goto failed
echo 下一步：按 README 接入 MCP 并安装附带 skill。
call npm run codex-config
if errorlevel 1 goto failed
:done
pause
exit /b 0
:missing
echo 请先安装 Node.js 24 或更新版本（包含 npm）：https://nodejs.org/
:failed
pause
exit /b 1
