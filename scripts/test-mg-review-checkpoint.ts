import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {runSolo, type SoloPhaseEvent} from "../runner/solo.js";
import {validateMgAnnotationHtml} from "../runner/mg/html.js";
import {novelPaths} from "../utils/paths.js";
import type {NovelSelection} from "../ui/select.js";

process.setMaxListeners(0);

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, {withFileTypes: true}).catch(() => [])) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(path.relative(root, fullPath).replaceAll("\\", "/"));
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function countPresetRows(content: string): number {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

async function main(): Promise<void> {
  const sourceFile = path.resolve(argument("source"));
  const projectName = argument("project");
  if (!argument("source") || !projectName) {
    throw new Error("用法: tsx scripts/test-mg-review-checkpoint.ts --source <文章.txt> --project <测试项目名>");
  }
  if (path.basename(projectName) !== projectName || /[<>:"/\\|?*\u0000-\u001f]/.test(projectName)) {
    throw new Error("测试项目名无效");
  }
  const sourceStat = await fs.stat(sourceFile);
  if (!sourceStat.isFile()) throw new Error("测试文章来源不是文件");

  const projectDir = novelPaths.workspaceDir(projectName);
  const sourceDir = path.join(projectDir, "source");
  const chapterPath = path.join(sourceDir, "第1章 测试文章.txt");
  try {
    await fs.access(projectDir);
    throw new Error(`测试项目已经存在，为避免覆盖已保留结果已停止: ${projectDir}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  await fs.mkdir(sourceDir, {recursive: true});
  await fs.copyFile(sourceFile, chapterPath);
  const progress = {
    novel_name: projectName,
    source_path: sourceDir,
    ethnicity: "",
    article_type: "essay",
    aspect_ratio: "16:9",
    render_mode: "full",
    review_visual_preset: true,
    require_final_confirmation: false,
    adapted: [],
    next_chapter: 1,
    global_summary: "",
    established_characters: [],
    established_locations: [],
    active_hooks: [],
  };
  await fs.writeFile(novelPaths.progress(projectName), JSON.stringify(progress, null, 4), "utf8");

  const selection: NovelSelection = {
    novelName: projectName,
    sourcePath: sourceDir,
    episode: 1,
    nextChapter: 1,
    ethnicity: "",
    aspectRatio: "16:9",
    imagesOnly: false,
    articleType: "essay",
    reviewVisualPreset: true,
    requireFinalConfirmation: false,
  };
  const startedAt = new Date();
  const phases: SoloPhaseEvent[] = [];
  let result = "not_started";
  let runError = "";
  try {
    result = await runSolo(selection, (event) => {
      phases.push(event);
      console.log(`[审核测试] ${event.label}${event.detail ? ` - ${event.detail}` : ""}`);
    });
  } catch (error) {
    runError = error instanceof Error ? error.stack || error.message : String(error);
  }

  const completedAt = new Date();
  const [savedProgress, article, html, preset] = await Promise.all([
    fs.readFile(novelPaths.progress(projectName), "utf8").then(JSON.parse),
    fs.readFile(novelPaths.cleanedText(projectName, 1), "utf8").catch(() => ""),
    fs.readFile(novelPaths.mgAnnotation(projectName, 1), "utf8").catch(() => ""),
    fs.readFile(novelPaths.visualPreset(projectName, 1), "utf8").catch(() => ""),
  ]);
  let annotationSummary = {groupCount: 0, tagCount: 0};
  let annotationValidationError = "";
  try {
    annotationSummary = validateMgAnnotationHtml(html, article);
  } catch (error) {
    annotationValidationError = error instanceof Error ? error.message : String(error);
  }

  const files = await listRelativeFiles(projectDir);
  const forbiddenFiles = files.filter((file) => /\.(?:png|jpe?g|webp|gif|mp4|mov|mkv|wav|mp3|aac)$/i.test(file));
  const forbiddenPaths = files.filter((file) => (
    /(^|\/)storyboards\//.test(file)
    || /(^|\/)render_[^/]+\//.test(file)
    || /(^|\/)mg\//.test(file)
    || /(^|\/)scripts\//.test(file)
  ));
  const stageRecord = savedProgress?.episodes?.["1"]?.stages || {};
  const checks = {
    stoppedAtReview: result === "review_pending" && stageRecord.visualPreset === "review",
    cleanCompleted: stageRecord.clean === "done" && Boolean(article.trim()),
    mgAnnotationCompleted: stageRecord.mgAnnotate === "done" && !annotationValidationError,
    visualPresetReady: Boolean(preset.trim()) && countPresetRows(preset) > 0,
    noMediaGenerated: forbiddenFiles.length === 0,
    noDownstreamDirectories: forbiddenPaths.length === 0,
    noGpuPhase: phases.every((event) => !["gpu_queued", "gpu_ready", "rendering", "gpu_stopped"].includes(event.phase)),
  };
  const passed = !runError && Object.values(checks).every(Boolean);
  const report = {
    test: "议论文画面与 MG 标注审核节点",
    passed,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    sourceFile,
    sourceSha256: crypto.createHash("sha256").update(await fs.readFile(sourceFile)).digest("hex"),
    projectName,
    projectDir,
    result,
    runError,
    stages: stageRecord,
    annotation: {...annotationSummary, validationError: annotationValidationError},
    visualPresetRows: countPresetRows(preset),
    phases,
    checks,
    forbiddenFiles,
    forbiddenPaths,
    retainedFiles: files,
  };
  const reportJsonPath = path.join(projectDir, "MG联合审核测试结果.json");
  const reportTextPath = path.join(projectDir, "MG联合审核测试结果.txt");
  const reportText = [
    `测试结果：${passed ? "通过" : "未通过"}`,
    `项目：${projectName}`,
    `来源：${sourceFile}`,
    `流水线返回：${result}`,
    `阶段：${JSON.stringify(stageRecord)}`,
    `MG 标注：${annotationSummary.groupCount} 个 group / ${annotationSummary.tagCount} 个标签`,
    `画面预设：${countPresetRows(preset)} 行`,
    `媒体文件：${forbiddenFiles.length} 个`,
    `下游目录文件：${forbiddenPaths.length} 个`,
    `GPU 阶段：${checks.noGpuPhase ? "未进入" : "异常进入"}`,
    `开始：${startedAt.toISOString()}`,
    `结束：${completedAt.toISOString()}`,
    runError ? `错误：${runError}` : "错误：无",
    "",
  ].join("\n");
  await Promise.all([
    fs.writeFile(reportJsonPath, JSON.stringify(report, null, 2), "utf8"),
    fs.writeFile(reportTextPath, reportText, "utf8"),
  ]);
  console.log(`[审核测试] 结果: ${passed ? "通过" : "未通过"}`);
  console.log(`[审核测试] 报告: ${reportTextPath}`);
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[审核测试] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
