/**
 * /status 命令 — 展示所有小说改编进度
 */

import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "../utils/paths.js";

interface EpisodeRecord {
  episode: number;
  title: string;
  source_chapters: number[];
  status: string;
  scene_count: number;
  timestamp: string;
}

interface Progress {
  novel_name: string;
  source_path?: string;
  adapted: EpisodeRecord[];
  next_chapter: number;
  global_summary: string;
  established_characters: string[];
  established_locations: string[];
  active_hooks: string[];
}

export async function showStatus() {
  const workspace = PATHS.workspace;

  let entries: string[];
  try {
    entries = await fs.readdir(workspace);
  } catch {
    console.log("\n  暂无改编记录。使用 /solo 或 /custom 开始改编。\n");
    return;
  }

  const novels: Progress[] = [];
  for (const name of entries) {
    const progressPath = path.join(workspace, name, "改编进度.json");
    try {
      const content = await fs.readFile(progressPath, "utf-8");
      novels.push(JSON.parse(content));
    } catch {
      // 不是有效的小说目录，跳过
    }
  }

  if (novels.length === 0) {
    console.log("\n  暂无改编记录。使用 /solo 或 /custom 开始改编。\n");
    return;
  }

  for (const novel of novels) {
    const sourceLine = novel.source_path ? `  来源: ${novel.source_path}` : "";
    console.log(`\n  ${novel.novel_name}${sourceLine}`);
    console.log("  " + "─".repeat(50));

    if (novel.adapted && novel.adapted.length > 0) {
      console.log("  集数       状态       场景数   更新时间");
      for (const ep of novel.adapted) {
        const epStr = `第${ep.episode}集`.padEnd(9);
        const statusStr = (ep.status === "done" ? "已完成" : ep.status).padEnd(9);
        const sceneStr = String(ep.scene_count).padEnd(7);
        const dateStr = ep.timestamp?.slice(0, 10) ?? "-";
        console.log(`  ${epStr} ${statusStr} ${sceneStr} ${dateStr}`);
      }
    } else {
      console.log("  尚未开始改编");
    }

    console.log("  " + "─".repeat(50));

    const chars = novel.established_characters ?? [];
    if (chars.length > 0) {
      console.log(`  角色(${chars.length}): ${chars.join("、")}`);
    }

    const locs = novel.established_locations ?? [];
    if (locs.length > 0) {
      console.log(`  场景(${locs.length}): ${locs.join("、")}`);
    }

    console.log(`  下一集: 第${(novel.adapted?.length ?? 0) + 1}集（从第${novel.next_chapter}章开始）`);

    const hooks = novel.active_hooks ?? [];
    if (hooks.length > 0) {
      console.log(`  悬念线索: ${hooks.join("、")}`);
    }
  }
  console.log();
}
