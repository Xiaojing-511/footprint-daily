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

/** 事件聚合成：应用时长、去重活跃时长、会话数、有序时间线（noiseSet 内的应用在源头剔除，避免污染活跃时长与休眠检测） */
export function aggregateEvents(events, { gapSeconds = 300, noiseSet = null } = {}) {
  const sorted = [...events]
    .filter((e) => !(noiseSet && noiseSet.has(e.data?.app)))
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

  const noise = new Set([...(config.noiseApps || []), "loginwindow"]);
  const windowAgg = aggregateEvents(windowEvents, { gapSeconds: config.focus.gapSeconds, noiseSet: noise });
  const webAgg = aggregateEvents(webEvents, { gapSeconds: config.focus.gapSeconds, noiseSet: noise });

  // afk：not-afk 时长 = 活跃
  let afkSeconds = null;
  if (afkEvents.length) {
    const notAfk = afkEvents.filter((e) => e.data?.status === "not-afk");
    afkSeconds = notAfk.reduce((a, e) => a + (e.duration || 0), 0);
  }

  const topApps = windowAgg.topApps.slice(0, 12);
  const topTitles = windowAgg.topTitles.slice(0, 25);

  const browserDetail = webAgg.entries
    .map((e) => ({ time: fmtLocal(e.time, offsetHours), app: "浏览器", label: ((e.title || "") + (e.url ? " [" + e.url + "]" : "")).slice(0, 150) }))
    .slice(0, 40);

  // 带休眠标注的时间线：两条记录之间无活动超过 sleepGapSeconds 时插入「休眠/离开」标记
  const sleepGap = config.focus?.sleepGapSeconds ?? 3600;
  const timeline = annotateTimeline(windowAgg.entries, noise, offsetHours, sleepGap).slice(0, 80);
  const sleepSegs = timeline.filter((x) => x.kind === "sleep");

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
    timeline,
    sleepSegments: sleepSegs.length,
    // 数据面板字符串（本地算，不给 LLM 编造空间）
    panel: {
      total: fmtHourMin(windowAgg.totalSeconds),
      active: fmtHourMin(afkSeconds ?? windowAgg.activeSeconds),
      sessions: String(windowAgg.sessionCount),
      topApps: topApps.map((x) => x.app + " " + fmtHourMin(x.seconds)).join("、") || "无",
      topContents: topTitles.slice(0, 8).map((x) => x.key.replace("｜", " — ") + "（" + fmtMin(x.seconds) + "min）").join("\n") || "无",
      activeRatio: windowAgg.totalSeconds > 0
        ? Math.round(((afkSeconds ?? windowAgg.activeSeconds) / Math.max(windowAgg.totalSeconds, 1)) * 100) + "%"
        : "—",
      sleep: sleepSegs.length
        ? sleepSegs.length + " 段（共 " + fmtHourMin(sleepSegs.reduce((a, s) => a + s.gapMin * 60, 0)) + "）"
        : "无"
    }
  };
}

/**
 * 时间线标注：活动条目之间无活动超过阈值时插入「休眠/离开」段。
 * entries: aggregateEvents 的 entries（含 start 秒级时间戳）
 */
function annotateTimeline(entries, noiseSet, offsetHours, sleepGapSeconds) {
  const acts = entries
    .filter((e) => !noiseSet.has(e.app) && (e.title || e.url))
    .map((e) => ({
      start: e.start,
      end: e.start + (e.duration || 0),
      app: e.app,
      label: (e.title || e.url || "").slice(0, 120)
    }))
    .sort((a, b) => a.start - b.start);

  const out = [];
  let prevEnd = null;
  const toISO = (sec) => new Date(sec * 1000).toISOString();
  for (const a of acts) {
    if (prevEnd !== null) {
      const gap = a.start - prevEnd;
      if (gap > sleepGapSeconds) {
        out.push({
          kind: "sleep",
          from: fmtLocal(toISO(prevEnd), offsetHours),
          to: fmtLocal(toISO(a.start), offsetHours),
          gapMin: Math.round(gap / 60)
        });
      }
    }
    out.push({ kind: "act", time: fmtLocal(toISO(a.start), offsetHours), app: a.app, label: a.label });
    prevEnd = a.end;
  }
  return out;
}
