# footprint-daily · 每日足迹日报

> Automatically generate a daily **"footprint" report** from your ActivityWatch data with LLM, and write it into **Notion** — every day at 21:00, no manual work.
>
> 基于 ActivityWatch + LLM，每天 21:00 自动生成当日「足迹」日报并写入 Notion，帮你复盘：**学了什么、做了什么、思路如何延伸、哪里可以优化**。

## 🎯 项目目的

大多数人很难回忆"今天到底学了什么、怎么从一个问题想到另一个问题"。ActivityWatch 记录了客观事实（应用、窗口、网页、时长），但没有语义；本项目补上这一层：

- **客观数据**：从 ActivityWatch (localhost:5600) 拉取当天时间线，本地聚合
- **语义复盘**：LLM 根据时间线 + 你的随手记，生成四段式日报
- **自动沉淀**：每天 21:00 定时写入 Notion 数据库，形成可检索的个人学习档案

每份日报包含：

| 板块 | 说明 |
|---|---|
| 📚 今天学习了什么 | 知识点/文档/文章，标注来源页面或应用 |
| 🔧 今天实践了什么 | 做了什么、产出了什么 |
| 🧩 思路延伸 | 从一个小问题/小思路出发，按时间线还原延伸到哪些其他问题 |
| ⚡ 效率与学习质量建议 | 结合数据（碎片时间/上下文切换/空闲占比）给出具体可执行建议 |
| 📊 数据面板 | 活跃时长、会话数、Top 应用/内容 —— 本地计算，不靠 AI 编造 |

## 🏗 工作原理

```
ActivityWatch (localhost:5600)
  ├─ aw-watcher-window   窗口标题（兜底数据）
  ├─ aw-watcher-web      网页标题/URL（推荐安装，提升"学了什么"质量）
  └─ aw-watcher-afk      离开/回来 → 活跃时长
        │  REST API /api/0/buckets/{id}/events
        ▼
数据聚合器 (Node.js，零第三方依赖，内置 fetch)
  ├─ 应用/内容聚合、时间线重建、会话合并
  ├─ 补充素材：git 提交、终端历史（可选）
        ▼
LLM（默认 DeepSeek，兼容 OpenAI/custom）
  └─ 结构化 JSON 输出（含 JSON 解析容错重试）
        ▼
Notion API
  └─ 写入数据库：日期 / 标题(Name) / 状态，正文含四大板块 + 数据面板
```

**隐私设计**：ActivityWatch 数据全部在本地聚合，只把聚合后的文本摘要发送给 LLM；所有密钥存 `.env`（已被 `.gitignore` 排除），不进仓库。

## 🚀 快速上手（约 10 分钟）

### 0. 前置条件

| 依赖 | 说明 |
|---|---|
| Node.js 18+ | 运行时（自带 fetch，零依赖） |
| ActivityWatch | 已安装并运行（`http://localhost:5600`） |
| 浏览器扩展 aw-watcher-web | 强烈推荐，记录网页标题/URL |
| Notion 账号 | 用于存日报与手记 |
| LLM API Key | 推荐 [DeepSeek](https://platform.deepseek.com)（国内直连、便宜） |

### 1. 克隆并配置

```bash
git clone https://github.com/<你的用户名>/footprint-daily.git
cd footprint-daily
cp .env.example .env
# 编辑 .env，填入：
#   LLM_API_KEY          DeepSeek/OpenAI Key（sk- 开头）
#   NOTION_TOKEN         Notion 集成 Token（secret_ 或 ntn_ 开头）
#   NOTION_DATABASE_ID   日报数据库 id（32 位 hex）
```

### 2. Notion 一次性准备

1. 打开 [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration** → 复制 **Internal Integration Token**
2. 新建一个 **Database**，创建 3 个属性（属性名可改，改后同步 `config.json` 的 `notion` 字段）：
   - `日期`（Date）
   - `Name`（Title，新建数据库默认就有）
   - `状态`（Select，选项：生成成功 / 部分失败）
3. 数据库页面右上 `...` → **Connections** → 邀请你的集成
4. 复制数据库 URL 中 `p/<32位hex>` 段的 id（**注意：是 p/ 段，不是 ?v= 的视图 id**）
5. 新建一个普通页面（如「足迹 · 随手记」）→ Connections 邀请集成 → 把页面 URL 中 32 位 hex 填入 `config.json` 的 `notesNotion.pageId`

### 3. 试跑

```bash
npm run probe   # 只看本地 AW 数据（不调 LLM，验证数据源）
npm run dry     # 生成完整日报预览（不写 Notion）
npm run report  # 生成并写入 Notion ✅
```

### 4. 定时任务（每天 21:00）

**macOS（launchd）**：

```bash
./install.sh            # 安装（21:00 执行；错过的时间会在下次唤醒时补跑）
./install.sh uninstall  # 卸载
```
> 自定义任务名：编辑 `install.sh` 与 `plist/com.zhangjingjing.footprint-daily.plist` 中的 Label。

**Linux（cron 示例）**：

```cron
0 21 * * * cd /path/to/footprint-daily && /usr/bin/node src/main.mjs >> /tmp/footprint.log 2>&1
```

## 📝 每天 2 分钟：随手记

在 Notion 的**「随手记」页面**里追加当天「学到了什么 / 卡点 / 想法」，21:00 日报自动读取**当天新建**的内容：

```
搞懂了 useMemo 的依赖规则
思考：useEffect 触发太频繁时怎么办？
卡点：腾讯云部署验证码搞了 10 分钟
```

- 任何格式都可以：段落、列表、标题、引用、待办
- 不需要时间戳/格式约定——按块的**创建时间**自动归到当天
- 不记也行：日报会退化为纯客观数据推断，并在建议里提醒你随手记

## ⚙️ 配置参考（config.json）

| 配置 | 说明 | 默认 |
|---|---|---|
| `focus.gapSeconds` | 间隔超过该秒数视为新会话 | 300 |
| `focus.contextSwitchGapSeconds` | 上下文切换判定间隔 | 60 |
| `noiseApps` | 不计入统计的系统应用 | 系统偏好设置、访达等 |
| `categories` | 应用分类（供后续扩展展示） | 开发/学习/沟通/创作/娱乐 |
| `collect.enabled` | 是否采集 git 提交 + 终端历史 | true |
| `collect.gitRepos` | 采集当日提交的仓库绝对路径列表 | [] |
| `collect.history` | 是否采集当日终端命令（zsh） | true |
| `notion` | Notion 属性名映射（propDate/propTitle/propStatus） | 日期/Name/状态 |
| `notesNotion.pageId` | 随手记页面 id（留空则不读取手记） | "" |
| `prompt.*` | LLM 系统提示词与模板，可按习惯调整 | 内置 |

## 📖 命令一览

| 命令 | 说明 |
|---|---|
| `npm run probe` | 本地数据摘要（不调 LLM） |
| `npm run dry` | 完整日报预览（不写 Notion） |
| `npm run report` | 生成并写入 Notion |
| `node src/main.mjs --date=2026-09-01` | 补生成某天 |
| `node src/main.mjs --yesterday` | 生成昨天 |
| `node src/main.mjs --force` | 当天已存在时强制重写 |
| `node src/main.mjs --probe` | 同 npm run probe |

## ❓ 常见问题

- **当天日报已存在**：加 `--force` 重写
- **浏览器 URL 空白**：安装 aw-watcher-web；未装时自动用窗口标题兜底
- **LLM 输出解析失败**：自动重试一次，仍失败则在日志中保留原始内容
- **21:00 电脑关机**：launchd 会在下次唤醒补跑；也可手动 `--date` 补生成
- **Notion 报 404**：集成未授权该页面/数据库 → 页面 `...` → Connections 邀请集成
- **数据库 id 填错**：`p/` 段才是数据库 id，`?v=` 是视图 id

## 🔒 隐私与安全

- ActivityWatch 数据仅本地处理，只发送聚合文本给 LLM
- 密钥仅存 `.env`（gitignored）；提交前请勿把真实密钥写进 `.env.example` 等任何入库文件
- 若曾误提交密钥：立即在对应平台**吊销并重新生成** key

## 📄 License

[MIT](./LICENSE)
