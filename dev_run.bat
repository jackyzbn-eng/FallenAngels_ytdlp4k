@echo off
rem Fallen Angels dev run - launch Electron from source directly, no install needed
rem 注意：必须清掉 ELECTRON_RUN_AS_NODE，否则 Electron 退化成 Node 模式并报
rem "Unable to find Electron app" / "Cannot find module ..."（部分宿主软件会注入此变量）
cd /d "%~dp0electron"
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0electron\node_modules\electron\dist\electron.exe" .
