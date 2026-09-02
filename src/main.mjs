#!/usr/bin/env node
import { loadEnv, loadConfig, log, tzOffsetHours, localToday, localYesterday, weekdayCN, dayRange, fmtLocal } from "./lib.mjs";
import { collectDayData } from "./aw.mjs";
import { gitCommits, shellHistory } from "./collect.mjs";
import { generateReport } from "./report.mjs";
import { createReportPage, findPageByDate, buildBlocks, getPageBlocks, extractTodayNotes, archiveBlock } from "./notion.mjs";

loadEnv();
const config = loadConfig();
const offset = tzOffsetHours();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name) => {
  const a = argv.find((x) => x.startsWith(name + "="));
  return a ? a.slice(name.length + 1) : undefined;
};

const dateStr = val("--date") || (flag("--yesterday") ? localYesterday(offset) : localToday(offset));
const dryRun = flag("--dry-run");
const probe = flag("--probe");
const force = flag("--force");
const noExtras = flag("--no-extras");

log("足迹日报 · 日期 = " + dateStr + " · dry-run = " + dryRun + " · probe = " + probe);

// 1) ActivityWatch 数据
const data = await collectDayData(dateStr, config, offset);
log("AW 数据: 总时长 " + data.panel.total + " | 活跃 " + data.panel.active +
  " | 会话 " + data.panel.sessions + " | 窗口桶: " + (data.windowBuckets.join(",") || "无"));

if (probe) {
  console.log("===== 数据面板（probe，仅本地数据，不调 LLM）=====");
  console.log(renderPanel(data.panel));
  console.log("===== 时间线（前 30 条）=====");
  for (const e of data.windowTimeline.slice(0, 30)) console.log(e.time, e.app, "|", e.label);
  process.exit(0);
}

// 2) 手记：从 Notion 固定页面读取「当天新建」的内容
let notes = "";
const notesPageId = config.notesNotion?.pageId;
if (notesPageId && process.env.NOTION_TOKEN) {
  const { start, end } = dayRange(dateStr, offset);
  const res = await getPageBlocks(process.env.NOTION_TOKEN, notesPageId);
  if (res.ok) {
    const entries = extractTodayNotes(res.blocks, start, end);
    notes = entries.map((e) => fmtLocal(e.created, offset) + " " + e.text).join("\n");
    log("手记: 从 Notion 页面读取到 " + entries.length + " 条（当天新建）");
  } else {
    log("⚠ 读取 Notion 手记页面失败: " + res.status + " " + res.message);
  }
} else {
  log("⚠ 未配置 notesNotion.pageId，本次无手记素材");
}

// 3) 补充素材（git 提交 / 终端历史）
let extras = "";
if (!noExtras && config.collect?.enabled) {
  const parts = [];
  if (config.collect.gitRepos?.length) {
    const g = gitCommits(dateStr, config.collect.gitRepos);
    if (g) parts.push("### Git 提交\n" + g);
  }
  if (config.collect.history) {
    const h = shellHistory(dateStr, offset);
    if (h) parts.push("### 终端历史（今日命令）\n" + h);
  }
  extras = parts.join("\n\n");
}

// 4) 无 LLM key 时给出降级输出
if (!process.env.LLM_API_KEY) {
  console.log("⚠ 未配置 LLM_API_KEY，仅输出本地数据摘要（配置后运行 npm run dry 查看完整日报）:");
  console.log(renderPanel(data.panel));
  if (notes) console.log("\n手记:\n" + notes);
  process.exit(2);
}

// 4.5) 提前查重（避免重复调 LLM / 重复写入；定时任务的重试轮次会因此变得廉价）
let existingPage = null;
if (!dryRun) {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    console.error("未配置 NOTION_TOKEN / NOTION_DATABASE_ID（见 .env.example 与 README 指引）");
    process.exit(2);
  }
  existingPage = await findPageByDate({
    databaseId: process.env.NOTION_DATABASE_ID, token: process.env.NOTION_TOKEN,
    dateStr, propDate: config.notion.propDate
  });
  if (existingPage && !force) {
    console.log("当天日报已存在: " + (existingPage.url || existingPage.id) + "（--force 可覆盖重写）");
    process.exit(0);
  }
}

// 5) LLM 生成
log("调用 LLM 生成日报 ...");
const gen = await generateReport({ data, notes, extras, config, weekday: weekdayCN(dateStr) });
if (!gen.ok) {
  console.error("生成失败:", gen.reason, gen.message);
  process.exit(1);
}
const report = gen.report;
const title = report.title || dateStr + " 足迹日报";

// 6) dry-run 预览
if (dryRun) {
  console.log("===== 日报预览（dry-run，未写入 Notion）=====");
  console.log("# " + title);
  if (report.summary) console.log("> " + report.summary);
  console.log("\n## 数据面板\n" + renderPanel(data.panel));
  console.log("\n## 📚 学习了什么\n" + (report.learned || ""));
  console.log("\n## 🔧 实践了什么\n" + (report.practiced || ""));
  console.log("\n## 🧩 思路延伸\n" + (report.extensions || ""));
  console.log("\n## ⚡ 效率与学习质量建议\n" + (report.efficiency || ""));
  process.exit(0);
}

// 7) 写入 Notion（查重已在 LLM 前完成；--force 时先归档旧页再新建）
if (existingPage && force) {
  await archiveBlock(process.env.NOTION_TOKEN, existingPage.id);
  log("已归档旧日报: " + existingPage.id);
}
const blocks = buildBlocks(report, data.panel);
const res = await createReportPage({
  databaseId: process.env.NOTION_DATABASE_ID, token: process.env.NOTION_TOKEN,
  dateStr, title, blocks, props: config.notion
});
if (res.ok) { console.log("✅ 日报已写入 Notion: " + res.url); process.exit(0); }
console.error("Notion 写入失败:", res.status, res.message);
process.exit(1);

function renderPanel(p) {
  return "- 总记录时长: " + p.total +
    "\n- 去重活跃时长: " + p.active + "（活跃占比 " + p.activeRatio + "）" +
    "\n- 连续工作时段: " + p.sessions + " 个" +
    "\n- Top 应用: " + p.topApps +
    "\n- Top 内容: " + p.topContents;
}
