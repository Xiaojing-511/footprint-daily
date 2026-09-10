#!/usr/bin/env bash
# 安装/卸载 21:00 定时任务
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.zhangjingjing.footprint-daily"
PLIST_SRC="$HERE/plist/$LABEL.plist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WATCH_LABEL="com.zhangjingjing.aw-watchdog"
WATCH_SRC="$HERE/plist/$WATCH_LABEL.plist"
WATCH="$HOME/Library/LaunchAgents/$WATCH_LABEL.plist"
LOG_DIR="$HOME/Library/Logs/footprint-daily"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl unload "$WATCH" 2>/dev/null || true
  rm -f "$PLIST" "$WATCH"
  echo "已卸载定时任务与 AW 保活守护"
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

# ActivityWatch 保活守护：每 5 分钟检查，掉线自动拉起
sed -e "s|__WATCHDOG_SH__|$HERE/scripts/aw-watchdog.sh|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$WATCH_SRC" > "$WATCH"
chmod +x "$HERE/scripts/aw-watchdog.sh"
launchctl unload "$WATCH" 2>/dev/null || true
launchctl load "$WATCH"

echo "✅ 已安装定时任务: 每天 21:00/21:30/22:00 生成当天足迹日报 ($HERE)"
echo "✅ 已安装 ActivityWatch 保活守护: 每 5 分钟检查，掉线自动拉起"
echo "   日志: $LOG_DIR/stdout.log / stderr.log / aw-watchdog.log"
echo "   卸载: $0 uninstall"
