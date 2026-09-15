#!/bin/bash
# Read-to-Output macOS 启动器
# 双击运行，或在终端执行：bash start-read-to-output.command
cd "$(dirname "$0")"

# 自动探测 pi 命令（npm 全局、homebrew、nvm 常见位置）
RTO_PI_CMD=""

if command -v pi >/dev/null 2>&1; then
  RTO_PI_CMD="$(command -v pi)"
elif [ -x "$HOME/.npm-global/bin/pi" ]; then
  RTO_PI_CMD="$HOME/.npm-global/bin/pi"
elif [ -x "/opt/homebrew/bin/pi" ]; then
  RTO_PI_CMD="/opt/homebrew/bin/pi"
elif [ -x "/usr/local/bin/pi" ]; then
  RTO_PI_CMD="/usr/local/bin/pi"
fi

if [ -z "$RTO_PI_CMD" ]; then
  echo "[Read-to-Output] 没有找到 pi 命令。"
  echo ""
  echo "请先安装 pi（也可以把下面这行发给 AI 帮你装）："
  echo "  npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
  echo ""
  echo "安装完成后重新双击本文件即可。"
  read -r -p "按回车键退出..." _
  exit 1
fi

"$RTO_PI_CMD" \
  --offline \
  --approve \
  --thinking off \
  --no-tools \
  --no-extensions \
  --extension ".pi/extensions/read-to-output.js" \
  --no-skills \
  --no-prompt-templates \
  --no-context-files \
  --no-themes

exit 0
