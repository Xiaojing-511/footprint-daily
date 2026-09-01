#!/usr/bin/env bash
# 安装/卸载 21:00 定时任务
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.zhangjingjing.footprint-daily"
PLIST_SRC="$HERE/plist/$LABEL.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/footprint-daily"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载定时任务 $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node，请先安装 Node 18+（https://nodejs.org）" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__MAIN_MJS__|$HERE/src/main.mjs|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$PLIST_SRC" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 已安装定时任务: 每天 21:00 生成当天足迹日报 ($HERE)"
echo "   日志: $LOG_DIR/stdout.log / stderr.log"
echo "   卸载: $0 uninstall"
