import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tzSuffix } from "./lib.mjs";

/** 指定日期内的 git 提交（多个仓库，逐个尝试） */
export function gitCommits(dateStr, repos) {
  const out = [];
  for (const repo of repos || []) {
    try {
      const res = execFileSync(
        "git",
        ["-C", repo, "log", "--since=" + dateStr + "T00:00:00", "--until=" + dateStr + "T23:59:59",
         "--pretty=format:%ad %h %s", "--date=format:%H:%M"],
        { encoding: "utf8", maxBuffer: 2_000_000 }
      );
      if (res.trim()) out.push("### " + repo + "\n" + res.trim());
    } catch { /* 仓库不存在或无提交则跳过 */ }
  }
  return out.join("\n\n");
}

/** 指定日期内的 zsh 历史命令（无时间戳时退化为最近 20 条并标注） */
export function shellHistory(dateStr, offsetHours) {
  const home = os.homedir();
  const zshPath = path.join(home, ".zsh_history");
  if (!existsSync(zshPath)) return "";
  const start = Math.floor(new Date(dateStr + "T00:00:00" + tzSuffix(offsetHours)).getTime() / 1000);
  const end = start + 86400;
  const lines = readFileSync(zshPath, "utf8").split("\n");
  const cmds = [];
  const noTs = [];
  for (const line of lines) {
    const m = line.match(/^: (\d+):\d*;(.*)$/);
    if (m) {
      const ts = Number(m[1]);
      if (ts >= start && ts <= end) cmds.push(m[2]);
    } else if (line.trim() && !line.startsWith("#")) {
      noTs.push(line.trim());
    }
  }
  if (cmds.length === 0 && noTs.length) {
    return noTs.slice(-20).map((c) => c + "（无时间戳，疑似当天）").join("\n");
  }
  return cmds.join("\n");
}
