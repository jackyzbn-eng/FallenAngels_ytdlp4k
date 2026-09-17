@echo off
rem ============================================================
rem  Fallen Angels 一键打包（Electron）
rem  用法：双击 = 按 package.json 里的当前版本打包
rem        或  build_electron.bat 2.8.3  指定版本号
rem ============================================================
setlocal enabledelayedexpansion

set "ELECDIR=%~dp0electron"
set "NODE_EXE=C:\Users\jacky\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

rem --- 可选：命令行传入版本号，写回 package.json ---
if not "%~1"=="" (
  echo 设置版本号为 %~1
  "%NODE_EXE%" "%~dp0_setver.js" "%~1"
)

echo.
echo 开始打包...
echo   注意：已禁用代码签名（本机无有效证书，签了也无效，
echo         且每个 exe 都要等时间戳服务器超时，约 20 分钟）

rem 关键：跳过签名。本机没有代码签名证书（已确认 CurrentUser / LocalMachine
rem 均无 CodeSigningCert），electron-builder 默认仍会对每个 exe 跑 signtool，
rem 10 个 exe 叠加等待超时 ~20 分钟，且签出来没有任何效力。
set CSC_IDENTITY_AUTO_DISCOVERY=false

rem 代理交给系统，不在这里清空（清空会让下载/签名走不了网）
set ELECTRON_RUN_AS_NODE=
set ELECTRON_MIRROR=
set ELECTRON_BUILDER_BINARIES_MIRROR=
set ELECTRON_CACHE=C:\Users\jacky\AppData\Local\electron\Cache
set ELECTRON_BUILDER_CACHE=C:\Users\jacky\AppData\Local\electron-builder\Cache

pushd "%ELECDIR%"
rem 清掉上次的产物。必须确认删干净 —— 残留的话 electron-builder 会在旧文件上叠加，
rem 导致"源码里已删的东西又出现在包里"（曾因此让删掉的 ffprobe.exe 复活）。
if exist dist\win-unpacked rmdir /s /q dist\win-unpacked
if exist dist\win-unpacked (
  echo.
  echo 清理失败：dist\win-unpacked 删不掉，可能有进程占用文件。
  echo 请关掉正在运行的 Fallen Angels / 相关 node 进程后重试。
  popd
  pause
  exit /b 1
)
del /q dist\*.blockmap 2>nul

"%NODE_EXE%" "node_modules\electron-builder\out\cli\cli.js" --win
set RC=%errorlevel%
popd

if not "%RC%"=="0" (
  echo.
  echo 打包失败，退出码 %RC%
  pause
  exit /b %RC%
)

rem --- 把最新安装包复制到桌面 ---
set "LATEST="
for /f "delims=" %%F in ('dir /b /od "%ELECDIR%\dist\FallenAngels_setup_*.exe" 2^>nul') do set "LATEST=%%F"
if defined LATEST (
  copy /y "%ELECDIR%\dist\!LATEST!" "%USERPROFILE%\Desktop" >nul
  echo.
  echo 完成：!LATEST!
  echo 已复制到桌面
) else (
  echo 未找到安装包
)
pause
