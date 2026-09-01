import { fmtLocal, fmtHourMin, fmtMin } from "./lib.mjs";

const BASE = process.env.AW_BASE_URL || "http://localhost:5600";

export async function listBuckets() {
  const r = await fetch(BASE + "/api/0/buckets/");
  if (!r.ok) throw new Error("AW listBuckets 失败: HTTP " + r.status);
  return await r.json();
}

export async function getBucketEvents(bucketId, start, end) {
  const url = BASE + "/api/0/buckets/" + encodeURIComponent(bucketId) +
    "/events?start=" + encodeURIComponent(start) + "&end=" + encodeURIComponent(end) + "&limit=-1";
  const r = await fetch(url);
  if (!r.ok) throw new Error("AW events 失败: HTTP " + r.status + " bucket=" + bucketId);
  return await r.json();
}

export const isWindowBucket = (id) => id.startsWith("aw-watcher-window_");
export const isWebBucket = (id) => id.includes("aw-watcher-web");
export const isAfkBucket = (id) => id.includes("aw-watcher-afk");

/** 事件聚合成：应用时长、去重活跃时长、会话数、有序时间线 */
export function aggregateEvents(events, { gapSeconds = 300 } = {}) {
  const sorted = [...events]
    .map((e) => ({ ...e, start: new Date(e.timestamp).getTime() / 1000 }))
    .sort((a, b) => a.start - b.start);

  const appSeconds = new Map();
  const titleSeconds = new Map();
  const entries = [];

  for (const e of sorted) {
    const app = e.data?.app || "未知";
    const dur = e.duration || 0;
    appSeconds.set(app, (appSeconds.get(app) || 0) + dur);
    const t = (e.data?.title || "").trim();
    if (t) {
      const key = app + "｜" + t;
      titleSeconds.set(key, (titleSeconds.get(key) || 0) + dur);
    }
    entries.push({
      start: e.start,
      time: e.timestamp,
      app,
      title: t,
      url: (e.data?.url || "").trim(),
      duration: dur
    });
  }

  // 区间合并 → 去重活跃时长
  let activeSeconds = 0;
  let cur = null;
  let sessionCount = 0;
  for (const e of sorted) {
    const s = e.start, en = s + (e.duration || 0);
    if (cur && s <= cur.end + gapSeconds) {
      cur.end = Math.max(cur.end, en);
    } else {
      if (cur) { activeSeconds += cur.end - cur.start; sessionCount++; }
      cur = { start: s, end: en };
    }
  }
  if (cur) { activeSeconds += cur.end - cur.start; sessionCount++; }

  const totalSeconds = sorted.reduce((a, e) => a + (e.duration || 0), 0);

  const topApps = [...appSeconds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([app, sec]) => ({ app, seconds: sec }));
  const topTitles = [...titleSeconds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, sec]) => ({ key, seconds: sec }));

  return { totalSeconds, activeSeconds, sessionCount, topApps, topTitles, entries };
}

/** 合并窗口事件与网页事件：网页(URL 粒度)优先，窗口兜底 */
export function mergeTimeline(windowAgg, webAgg, offsetHours) {
  const entries = [];
  const used = new Set();
  for (const w of webAgg.entries) {
    entries.push({
      start: w.start,
      time: w.time,
      label: (w.title || "") + (w.url ? " [" + w.url + "]" : ""),
      app: "浏览器",
      duration: w.duration
    });
    used.add(w.start);
  }
  for (const e of windowAgg.entries) {
    if (used.has(e.start)) continue;
    const label = e.url && !e.title ? e.url : e.title;
    entries.push({
      start: e.start,
      time: e.time,
      label,
      app: e.app,
      duration: e.duration
    });
  }
  entries.sort((a, b) => a.start - b.start);
  return entries.map((e) => ({
    time: fmtLocal(e.time, offsetHours),
    app: e.app,
    label: (e.label || "").slice(0, 120)
  }));
}

/** 采集某天的完整数据摘要（供 LLM 与数据面板使用） */
export async function collectDayData(dateStr, config, offsetHours) {
  const { start, end } = (await import("./lib.mjs")).dayRange(dateStr, offsetHours);
  const buckets = await listBuckets();
  const all = Object.values(buckets);

  const windowBuckets = all.filter((b) => isWindowBucket(b.id));
  const webBuckets = all.filter((b) => isWebBucket(b.id));
  const afkBuckets = all.filter((b) => isAfkBucket(b.id));

  const [windowEvents, webEvents, afkEvents] = await Promise.all([
    Promise.all(windowBuckets.map((b) => getBucketEvents(b.id, start, end))).then((a) => a.flat()),
    Promise.all(webBuckets.map((b) => getBucketEvents(b.id, start, end))).then((a) => a.flat()),
    Promise.all(afkBuckets.map((b) => getBucketEvents(b.id, start, end))).then((a) => a.flat())
  ]);

  const windowAgg = aggregateEvents(windowEvents, { gapSeconds: config.focus.gapSeconds });
  const webAgg = aggregateEvents(webEvents, { gapSeconds: config.focus.gapSeconds });

  // afk：not-afk 时长 = 活跃
  let afkSeconds = null;
  if (afkEvents.length) {
    const notAfk = afkEvents.filter((e) => e.data?.status === "not-afk");
    afkSeconds = notAfk.reduce((a, e) => a + (e.duration || 0), 0);
  }

  const noise = new Set(config.noiseApps || []);
  const topApps = windowAgg.topApps.filter((x) => !noise.has(x.app)).slice(0, 12);
  const topTitles = windowAgg.topTitles
    .filter((x) => !noise.has(x.key.split("｜")[0]))
    .slice(0, 25);

  const windowTimeline = windowAgg.entries
    .filter((e) => !noise.has(e.app) && (e.title || e.url))
    .map((e) => ({ time: fmtLocal(e.time, offsetHours), app: e.app, label: (e.title || e.url || "").slice(0, 120) }))
    .slice(0, 60);
  const browserDetail = webAgg.entries
    .map((e) => ({ time: fmtLocal(e.time, offsetHours), app: "浏览器", label: ((e.title || "") + (e.url ? " [" + e.url + "]" : "")).slice(0, 150) }))
    .slice(0, 40);

  return {
    dateStr,
    windowBuckets: windowBuckets.map((b) => b.id),
    webBuckets: webBuckets.map((b) => b.id),
    afkBuckets: afkBuckets.map((b) => b.id),
    hasWebWatcher: webBuckets.length > 0,
    totalSeconds: windowAgg.totalSeconds,
    activeSeconds: afkSeconds ?? windowAgg.activeSeconds,
    sessionCount: windowAgg.sessionCount,
    topApps,
    topTitles,
    browserDetail,
    windowTimeline,
    // 数据面板字符串（本地算，不给 LLM 编造空间）
    panel: {
      total: fmtHourMin(windowAgg.totalSeconds),
      active: fmtHourMin(afkSeconds ?? windowAgg.activeSeconds),
      sessions: String(windowAgg.sessionCount),
      topApps: topApps.map((x) => x.app + " " + fmtHourMin(x.seconds)).join("、") || "无",
      topContents: topTitles.slice(0, 8).map((x) => x.key.replace("｜", " — ") + "（" + fmtMin(x.seconds) + "min）").join("\n") || "无",
      activeRatio: windowAgg.totalSeconds > 0
        ? Math.round(((afkSeconds ?? windowAgg.activeSeconds) / Math.max(windowAgg.totalSeconds, 1)) * 100) + "%"
        : "—"
    }
  };
}
