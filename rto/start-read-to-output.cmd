@echo off
setlocal
cd /d "%~dp0"

rem ===== 自动探测 pi 命令（兼容不同 Node 安装方式）=====
set "RTO_PI_CMD="

rem 1) 常见全局 npm 位置
if exist "%APPDATA%\npm\pi.cmd" set "RTO_PI_CMD=%APPDATA%\npm\pi.cmd"
if not defined RTO_PI_CMD if exist "%ProgramFiles%\nodejs\pi.cmd" set "RTO_PI_CMD=%ProgramFiles%\nodejs\pi.cmd"

rem 2) PATH 中查找
if not defined RTO_PI_CMD (
  for /f "delims=" %%i in ('where pi 2^>nul') do (
    if not defined RTO_PI_CMD set "RTO_PI_CMD=%%i"
  )
)

rem 3) nvm 常见位置（扫描 nodejs 目录下的 pi.cmd）
if not defined RTO_PI_CMD (
  if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\pi.cmd" set "RTO_PI_CMD=%NVM_SYMLINK%\pi.cmd"
)

if not defined RTO_PI_CMD (
  echo [Read-to-Output] 没有找到 pi 命令。
  echo.
  echo 请先安装 pi（也可以把下面这行发给 AI 帮你装）：
  echo   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  echo.
  echo 安装完成后重新双击本文件即可。
  pause
  exit /b 1
)

call "%RTO_PI_CMD%" ^
  --offline ^
  --approve ^
  --thinking off ^
  --no-tools ^
  --no-extensions ^
  --extension ".pi\extensions\read-to-output.js" ^
  --no-skills ^
  --no-prompt-templates ^
  --no-context-files ^
  --no-themes

endlocal
