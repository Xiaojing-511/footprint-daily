const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function headers(token) {
  return { Authorization: "Bearer " + token, "Notion-Version": VERSION, "Content-Type": "application/json" };
}

function richText(text) {
  return { type: "text", text: { content: String(text || "").slice(0, 2000) } };
}

function blockHeading(level, text) {
  const key = "heading_" + level;
  return { object: "block", type: key, [key]: { rich_text: [richText(text)] } };
}

function blockPara(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [richText(text)] } };
}

function renderPanel(panel) {
  return [
    "- 总记录时长: " + panel.total,
    "- 去重活跃时长: " + panel.active + "（活跃占比 " + panel.activeRatio + "）",
    "- 连续工作时段: " + panel.sessions + " 个",
    "- 休眠/离开: " + (panel.sleep || "无"),
    "- Top 应用: " + panel.topApps,
    "- Top 内容: " + panel.topContents
  ].join("\n");
}

/** 把结构化日报渲染成 Notion 子块（<100 块限制内） */
export function buildBlocks(report, panel) {
  const blocks = [];
  blocks.push(blockHeading(2, "📊 数据面板（ActivityWatch）"));
  blocks.push(blockPara(renderPanel(panel)));

  const sections = [
    ["📚 今天学习了什么", report.learned],
    ["🔧 今天实践了什么", report.practiced],
    ["🧩 思路延伸（小问题 → 其他问题）", report.extensions],
    ["⚡ 效率与学习质量优化建议", report.efficiency]
  ];
  for (const [h, body] of sections) {
    blocks.push(blockHeading(2, h));
    blocks.push(blockPara(body || "（空）"));
  }
  return blocks;
}

/** 按日期查询是否已存在日报 */
export async function findPageByDate({ databaseId, token, dateStr, propDate }) {
  const body = { filter: { property: propDate, date: { equals: dateStr } }, page_size: 1 };
  const r = await fetch(API + "/databases/" + databaseId + "/query", {
    method: "POST", headers: headers(token), body: JSON.stringify(body)
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.results?.[0] || null;
}

/** 归档（删除）页面或块 */
export async function archiveBlock(token, id) {
  const r = await fetch(API + "/blocks/" + id, { method: "DELETE", headers: headers(token) });
  return r.ok;
}

/** 创建日报页面（429/5xx 指数退避重试） */
export async function createReportPage({ databaseId, token, dateStr, title, blocks, props }) {
  const body = {
    parent: { database_id: databaseId },
    properties: {
      [props.propDate]: { date: { start: dateStr } },
      [props.propTitle]: { title: [{ text: { content: String(title || dateStr + " 足迹日报").slice(0, 100) } }] },
      [props.propStatus]: { select: { name: "生成成功" } }
    },
    children: blocks
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(API + "/pages", { method: "POST", headers: headers(token), body: JSON.stringify(body) });
    if (r.ok) {
      const j = await r.json();
      return { ok: true, url: j.url, id: j.id };
    }
    const t = await r.text().catch(() => "");
    if (r.status === 429 || r.status >= 500) {
      const retry = (Number(r.headers.get("retry-after")) || 2) * 1000 * attempt;
      await sleep(retry);
      continue;
    }
    return { ok: false, status: r.status, message: t.slice(0, 600) };
  }
  return { ok: false, status: "retry-exhausted", message: "429/5xx 重试 3 次仍失败" };
}
/** 分页读取页面所有子块 */
export async function getPageBlocks(token, pageId) {
  const blocks = [];
  let cursor = null;
  do {
    let url = API + "/blocks/" + pageId + "/children?page_size=100";
    if (cursor) url += "&start_cursor=" + encodeURIComponent(cursor);
    const r = await fetch(url, { headers: headers(token) });
    if (!r.ok) return { ok: false, status: r.status, message: (await r.text().catch(() => "")).slice(0, 300) };
    const j = await r.json();
    blocks.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return { ok: true, blocks };
}

/** 从块列表提取 [dayStart, dayEnd] 时间段内新建的文本条目（按创建时间排序） */
export function extractTodayNotes(blocks, dayStartISO, dayEndISO) {
  const start = new Date(dayStartISO).getTime();
  const end = new Date(dayEndISO).getTime();
  const TEXT_TYPES = new Set(["paragraph", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "heading_1", "heading_2", "heading_3"]);
  return blocks
    .filter((b) => TEXT_TYPES.has(b.type))
    .map((b) => {
      const rt = b[b.type]?.rich_text || [];
      return { created: b.created_time, text: rt.map((x) => x.plain_text).join("").trim() };
    })
    .filter((e) => e.text && new Date(e.created).getTime() >= start && new Date(e.created).getTime() <= end)
    .sort((a, b) => new Date(a.created) - new Date(b.created));
}
