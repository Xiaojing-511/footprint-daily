import { fmtHourMin, fmtMin, log } from "./lib.mjs";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 用真实数据填充 prompt 模板 */
export function buildUserPrompt(data, notes, extras, config, weekday) {
  const t = config.prompt.userTemplate;
  const topApps = data.topApps.map((x) => "- " + x.app + ": " + fmtHourMin(x.seconds)).join("\n") || "- 无";
  const topTitles = data.topTitles.slice(0, 20).map((x) => "- " + x.key + "（" + fmtMin(x.seconds) + "min）").join("\n") || "- 无";
  const browserDetail = data.browserDetail.length
    ? data.browserDetail.map((e) => "- " + e.time + " " + e.app + ": " + e.label).join("\n")
    : "- （未检测到浏览器扩展数据，已用窗口标题兜底）";
  const timeline = data.windowTimeline.length
    ? data.windowTimeline.map((e) => "- " + e.time + " " + e.app + ": " + e.label).join("\n")
    : "- 无";
  const notesText = notes
    ? notes
    : "（无手记。请只依据客观数据推断，并在 efficiency 中建议用户在 Notion 固定手记页面随手记录当天所学）";

  return t
    .replaceAll("{date}", data.dateStr)
    .replaceAll("{weekday}", weekday)
    .replaceAll("{totalMinutes}", String(fmtMin(data.totalSeconds)))
    .replaceAll("{activeMinutes}", String(fmtMin(data.activeSeconds)))
    .replaceAll("{sessionCount}", String(data.sessionCount))
    .replaceAll("{topApps}", topApps)
    .replaceAll("{topTitles}", topTitles)
    .replaceAll("{browserDetail}", browserDetail)
    .replaceAll("{timeline}", timeline)
    .replaceAll("{notes}", notesText)
    .replaceAll("{extras}", extras || "（无）");
}

function parseReportJson(content) {
  let c = (content || "").trim();
  c = c.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return { ok: true, report: JSON.parse(c) }; } catch {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) { try { return { ok: true, report: JSON.parse(m[0]) }; } catch {} }
  return { ok: false };
}

/** 调用 LLM 生成结构化日报 */
export async function generateReport({ data, notes, extras, config, weekday }) {
  const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return { ok: false, reason: "NO_LLM_KEY", message: "未配置 LLM_API_KEY（见 .env.example 与 README 指引）" };

  let baseUrl, defaultModel;
  if (provider === "deepseek") { baseUrl = "https://api.deepseek.com"; defaultModel = "deepseek-chat"; }
  else if (provider === "openai") { baseUrl = "https://api.openai.com/v1"; defaultModel = "gpt-4o-mini"; }
  else if (provider === "custom") { baseUrl = (process.env.LLM_BASE_URL || "").replace(/\/$/, ""); defaultModel = "deepseek-chat"; }
  else return { ok: false, reason: "BAD_PROVIDER", message: "未知 LLM_PROVIDER: " + provider };

  if (!baseUrl) return { ok: false, reason: "NO_LLM_BASE_URL", message: "custom 提供商需要在 .env 里配置 LLM_BASE_URL" };
  const model = process.env.LLM_MODEL || defaultModel;

  const body = {
    model,
    messages: [
      { role: "system", content: config.prompt.system },
      { role: "user", content: buildUserPrompt(data, notes, extras, config, weekday) }
    ],
    temperature: 0.6,
    max_tokens: 3000,
    response_format: { type: "json_object" }
  };

  const url = baseUrl + "/chat/completions";
  log("LLM 请求: " + provider + " / " + model);

  const backoff = [0, 5000, 15000, 30000]; // 第 n 次失败后的等待
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 90000); // 90s 超时保护
      try {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify(body),
          signal: ac.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      if (attempt < 3) { log("LLM 网络失败(" + attempt + "/3)，" + backoff[attempt + 1] / 1000 + "s 后重试: " + String(e).slice(0, 120)); await sleep(backoff[attempt + 1]); continue; }
      return { ok: false, reason: "LLM_NETWORK", message: String(e).slice(0, 300) };
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (attempt < 3 && (r.status === 429 || r.status >= 500)) { log("LLM HTTP " + r.status + "(" + attempt + "/3)，" + backoff[attempt + 1] / 1000 + "s 后重试"); await sleep(backoff[attempt + 1]); continue; }
      return { ok: false, reason: "LLM_HTTP_" + r.status, message: t.slice(0, 500) };
    }
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content || "";
    const parsed = parseReportJson(content);
    if (parsed.ok) return { ok: true, report: parsed.report, raw: content };
    if (attempt < 3) { log("LLM JSON 解析失败(" + attempt + "/3)，重试中..."); continue; }
    return { ok: false, reason: "LLM_JSON_PARSE", message: content.slice(0, 800) };
  }
  return { ok: false, reason: "UNREACHABLE", message: "内部错误" };
}
