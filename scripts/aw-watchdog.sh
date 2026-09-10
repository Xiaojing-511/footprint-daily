#!/usr/bin/env bash
# ActivityWatch 保活守护：检测不到服务就自动拉起
# 用法：由 launchd 每 5 分钟调用一次（见 plist/com.zhangjingjing.aw-watchdog.plist）
set -uo pipefail

API="http://127.0.0.1:5600/api/0/info"
LOG="${HOME}/Library/Logs/footprint-daily/aw-watchdog.log"
mkdir -p "$(dirname "$LOG")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 已运行 → 静默退出
if curl -s -m 5 "$API" >/dev/null 2>&1; then
  exit 0
fi

echo "$(ts) AW 不可达，尝试拉起 ..." >> "$LOG"
open -a ActivityWatch 2>/dev/null || open -a "ActivityWatch.app" 2>/dev/null

# 等待最多 30 秒
for i in $(seq 1 10); do
  sleep 3
  if curl -s -m 5 "$API" >/dev/null 2>&1; then
    echo "$(ts) ✅ AW 已恢复运行（等待 ${i}0 秒内）" >> "$LOG"
    exit 0
  fi
done

echo "$(ts) ❌ AW 拉起失败，请手动打开 ActivityWatch" >> "$LOG"
exit 1
