import { runSolo } from "../runner/solo.js";
import type { NovelSelection } from "../ui/select.js";

process.setMaxListeners(0);

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const input = await readInput();
  const selection = JSON.parse(input) as NovelSelection;
  if (!selection.novelName || !selection.sourcePath) throw new Error("缺少项目或章节源目录");
  console.log(`[desktop] 开始运行 ${selection.novelName} · 第 ${selection.episode} 集`);
  console.log(`[desktop] 模式：${selection.imagesOnly ? "只生成分镜图" : "完整渲染"}`);
  const result = await runSolo(selection);
  console.log(`[desktop] 任务结束：${result}`);
  if (result === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[desktop] 任务异常：${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
