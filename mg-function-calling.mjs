/**
 * 独立的 MG Function Calling 脚本
 * 读取 HTML + 时间轴，调用 LLM 输出所有 MG 模板的函数调用参数
 */
import fs from "node:fs/promises";
import path from "node:path";
import {getMgTemplateProvider} from "@story-claw/mg-templates/provider";

const provider = getMgTemplateProvider();

async function main() {
  const htmlPath = process.argv[2];
  const timelinePath = process.argv[3];
  
  if (!htmlPath || !timelinePath) {
    console.error("用法: node mg-function-calling.mjs <HTML路径> <时间轴路径>");
    process.exit(1);
  }

  console.log("=".repeat(80));
  console.log("MG Function Calling - 独立测试");
  console.log("=".repeat(80));
  
  // 读取输入
  const html = await fs.readFile(htmlPath, "utf-8");
  const timeline = JSON.parse(await fs.readFile(timelinePath, "utf-8"));
  
  console.log(`✓ HTML: ${htmlPath}`);
  console.log(`✓ 时间轴: ${timelinePath} (${timeline.words.length} 字, ${timeline.duration.toFixed(2)}s)`);
  
  // 提取 HTML 中使用的标签
  const tagMatches = html.matchAll(/<(progress-timeline|sc-video|sc-longtake|video-footage|directed-graph|decomposition|multi-series-chart|containment|collage-network|era-shift|route-shift|news-report|emphasis|mg-effect)/g);
  const htmlTags = [...new Set([...tagMatches].map(m => m[1]))];
  
  console.log(`✓ 检测到 ${htmlTags.length} 种 MG 标签: ${htmlTags.join(", ")}`);
  
  // 获取对应的 Function Calling 工具
  const tools = provider.getPlanningTools(htmlTags);
  console.log(`✓ 可用工具: ${tools.length} 个`);
  console.log("-".repeat(80));
  
  tools.forEach((tool, i) => {
    console.log(`[${i + 1}] ${tool.name}: ${tool.label}`);
  });
  
  console.log("=".repeat(80));
  console.log("接下来需要调用 LLM，传入以下内容：");
  console.log("1. 完整 HTML");
  console.log("2. 字级时间轴");
  console.log("3. Function Calling 工具定义");
  console.log("4. Planning Instructions");
  console.log("=".repeat(80));
  
  // 获取 planning instructions
  const planningInstructions = provider.getPlanningInstructions();
  const templateInstructions = provider.getTemplatePlanningInstructions(htmlTags);
  
  console.log("\n### Planning Instructions 预览 (前 500 字符):");
  console.log(planningInstructions.slice(0, 500) + "...");
  console.log("\n### Template-Specific Instructions 预览 (前 300 字符):");
  console.log(templateInstructions.slice(0, 300) + "...");
  
  console.log("\n=".repeat(80));
  console.log("⚠️  实际 LLM 调用需要：");
  console.log("1. OpenAI API Key");
  console.log("2. 模型选择 (建议 gpt-4 或更高)");
  console.log("3. 完整的 System Prompt + User Prompt 构建");
  console.log("=".repeat(80));
}

main().catch(console.error);
