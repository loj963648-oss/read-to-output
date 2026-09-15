@echo off
setlocal
cd /d "%~dp0"
set "RTO_PI_CMD=%APPDATA%\npm\pi.cmd"
set "RTO_RUNTIME_DIRECTORY=.read-to-output-sandbox"

if not exist "%RTO_PI_CMD%" (
  echo Pi was not found at: %RTO_PI_CMD%
  pause
  exit /b 1
)

if not exist ".read-to-output-sandbox\state.json" (
  node scripts\reset-sandbox.mjs
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
