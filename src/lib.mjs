import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 简易 .env 加载（不覆盖已存在的环境变量） */
export function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function loadConfig() {
  return JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
}

export function log(...args) {
  console.log("[" + new Date().toISOString() + "]", ...args);
}

export function tzOffsetHours() {
  return Number(process.env.TZ_OFFSET_HOURS || 8);
}

export function tzSuffix(offsetHours) {
  const sign = offsetHours < 0 ? "-" : "+";
  return sign + String(Math.abs(offsetHours)).padStart(2, "0") + ":00";
}

/** 本地日期字符串（YYYY-MM-DD） */
export function localToday(offsetHours = tzOffsetHours()) {
  const d = new Date(Date.now() + offsetHours * 3600_000);
  return d.toISOString().slice(0, 10);
}

/** 本地日期字符串：昨天 */
export function localYesterday(offsetHours = tzOffsetHours()) {
  const d = new Date(Date.now() + offsetHours * 3600_000 - 86400_000);
  return d.toISOString().slice(0, 10);
}

/** 某本地日期的 UTC 起止（ISO 字符串） */
export function dayRange(dateStr, offsetHours = tzOffsetHours()) {
  const start = new Date(dateStr + "T00:00:00" + tzSuffix(offsetHours)).toISOString();
  const end = new Date(dateStr + "T23:59:59" + tzSuffix(offsetHours)).toISOString();
  return { start, end };
}

/** ISO 时间 → 本地 HH:MM */
export function fmtLocal(iso, offsetHours = tzOffsetHours()) {
  const d = new Date(iso);
  return new Date(d.getTime() + offsetHours * 3600_000).toISOString().slice(11, 16);
}

export function weekdayCN(dateStr) {
  const d = new Date(dateStr + "T00:00:00" + tzSuffix(tzOffsetHours()));
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
}

export function fmtMin(seconds) {
  return Math.round(seconds / 60);
}

export function fmtHourMin(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return m + " 分钟";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? h + " 小时" : h + " 小时 " + mm + " 分钟";
}
