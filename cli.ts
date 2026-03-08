/**
 * Vision Builder — CLI 入口
 *
 * 命令行交互界面，支持 /status、/solo、/custom、/help、/exit 命令。
 */

import readline from "node:readline";
import { showWelcome, showHelp } from "./ui/welcome.js";
import { showStatus } from "./ui/status.js";
import { selectNovel } from "./ui/select.js";
import { runSolo } from "./runner/solo.js";
import { runCustom } from "./runner/custom.js";
import { ensureSetup } from "./utils/setup.js";

async function main() {
  // 首次运行引导：检查 ~/.vision-builder/ 配置
  const ready = await ensureSetup();
  if (!ready) {
    process.exit(0);
  }

  showWelcome();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let closed = false;
  rl.on("close", () => {
    closed = true;
    console.log("\n  再见！\n");
    process.exit(0);
  });

  const prompt = () => {
    if (closed) return;
    rl.question("  > ", async (input) => {
      const cmd = input.trim().toLowerCase();

      switch (cmd) {
        case "/status":
          await showStatus();
          break;

        case "/solo": {
          const sel = await selectNovel(rl);
          if (sel) await runSolo(sel);
          break;
        }

        case "/custom": {
          const sel = await selectNovel(rl);
          if (sel) await runCustom(sel, rl);
          break;
        }

        case "/help":
          showHelp();
          break;

        case "/exit":
          rl.close();
          return;

        case "":
          break;

        default:
          console.log("  未知命令，输入 /help 查看帮助\n");
          break;
      }

      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
