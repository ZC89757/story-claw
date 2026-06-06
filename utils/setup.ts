/**
 * setup.ts — 首次运行引导
 *
 * 检查 CONFIG_DIR (~/.story-claw/) 中是否存在配置文件，
 * 若缺失则交互式引导用户创建。
 */

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { CONFIG_DIR } from "./run-python.js";

const CONFIG_FILE          = path.join(CONFIG_DIR, "config.json");
const IMAGE_GEN_CONFIG_FILE = path.join(CONFIG_DIR, "image_gen_config.json");
const VIDEO_CONFIG_FILE     = path.join(CONFIG_DIR, "video_config.json");
const TTS_CONFIG_FILE       = path.join(CONFIG_DIR, "tts_config.json");

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查配置文件是否齐全，缺失则引导用户填写。
 * 返回 true 表示可以继续运行，false 表示用户中止。
 */
export async function ensureSetup(): Promise<boolean> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const hasConfig   = await fileExists(CONFIG_FILE);
  const hasImageGen = await fileExists(IMAGE_GEN_CONFIG_FILE);
  const hasVideo    = await fileExists(VIDEO_CONFIG_FILE);
  const hasTts      = await fileExists(TTS_CONFIG_FILE);

  if (hasConfig && hasImageGen && hasVideo && hasTts) return true;

  // 需要引导
  console.log("\n  首次运行，需要配置 API 密钥。");
  console.log(`  配置目录: ${CONFIG_DIR}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ── config.json（LLM 配置）──
    if (!hasConfig) {
      console.log("  ── LLM 配置 (config.json) ──");
      console.log("  支持的 provider: openai / anthropic / google\n");

      const provider = await ask(rl, "  provider (openai/anthropic/google): ");
      if (!["openai", "anthropic", "google"].includes(provider)) {
        console.log("  无效的 provider，中止。");
        return false;
      }

      const model = await ask(rl, "  model (如 gpt-4o / claude-sonnet-4-20250514 / gemini-2.0-flash): ");
      if (!model) {
        console.log("  model 不能为空，中止。");
        return false;
      }

      const apiKey = await ask(rl, "  api_key: ");
      if (!apiKey) {
        console.log("  api_key 不能为空，中止。");
        return false;
      }

      const baseUrl = await ask(rl, "  base_url (可选，直接回车跳过): ");

      const config: Record<string, string> = { provider, model, api_key: apiKey };
      if (baseUrl) config.base_url = baseUrl;

      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
      console.log(`  已保存: ${CONFIG_FILE}\n`);
    }

    // ── image_gen_config.json（Gemini 图像生成配置）──
    if (!hasImageGen) {
      console.log("  ── 图像生成配置 (image_gen_config.json) ──");
      console.log("  用于 Gemini 图像生成 API\n");

      const apiKey = await ask(rl, "  api_key: ");
      if (!apiKey) {
        console.log("  api_key 不能为空，中止。");
        return false;
      }

      const model = await ask(rl, "  model (如 gemini-2.0-flash-exp-image-generation): ");
      if (!model) {
        console.log("  model 不能为空，中止。");
        return false;
      }

      const baseUrl = await ask(rl, "  base_url: ");
      if (!baseUrl) {
        console.log("  base_url 不能为空，中止。");
        return false;
      }

      const config = { api_key: apiKey, model, base_url: baseUrl };
      await fs.writeFile(IMAGE_GEN_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
      console.log(`  已保存: ${IMAGE_GEN_CONFIG_FILE}\n`);
    }

    // ── video_config.json（视频生成配置）──
    if (!hasVideo) {
      console.log("  ── 视频生成配置 (video_config.json) ──\n");

      const apiKey = await ask(rl, "  api_key: ");
      if (!apiKey) { console.log("  api_key 不能为空，中止。"); return false; }

      const baseUrl = await ask(rl, "  base_url (如 https://zenmux.ai/api/vertex-ai): ");
      if (!baseUrl) { console.log("  base_url 不能为空，中止。"); return false; }

      const config = {
        api_key: apiKey,
        base_url: baseUrl,
        models: [
          "bytedance/doubao-seedance-2.0",
          "bytedance/doubao-seedance-1.5-pro",
          "google/veo-3.1-generate-001",
        ],
        default_duration: 4,
        concurrency: 4,
      };
      await fs.writeFile(VIDEO_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
      console.log(`  已保存: ${VIDEO_CONFIG_FILE}\n`);
    }

    // ── tts_config.json（豆包 / 火山引擎 语音合成大模型 V3）──
    if (!hasTts) {
      console.log("  ── TTS 配置 (tts_config.json) ──");
      console.log("  使用豆包语音（火山引擎 语音合成大模型 V3）\n");

      const apiKey = await ask(rl, "  api_key (火山引擎控制台 X-Api-Key): ");
      if (!apiKey) { console.log("  api_key 不能为空，中止。"); return false; }

      const resourceId = await ask(rl, "  resource_id (直接回车使用默认 seed-tts-1.0): ");

      const config = {
        api_key: apiKey,
        base_url: "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
        resource_id: resourceId || "seed-tts-1.0",
        voices: {
          "zh_male_jieshuonansheng_mars_bigtts": "男",
          "zh_male_qingcang_mars_bigtts": "男",
          "zh_male_silang_mars_bigtts": "男",
          "ICL_zh_male_badaozongcai_v1_tob": "男",
          "ICL_zh_male_lengmonanyou_tob": "男",
          "ICL_zh_male_wenrounanyou_tob": "男",
          "ICL_zh_male_shaonianjiangjun_tob": "男",
          "zh_female_gaolengyujie_moon_bigtts": "女",
          "zh_female_wuzetian_mars_bigtts": "女",
          "zh_female_gufengshaoyu_mars_bigtts": "女",
          "zh_female_wenroushunv_mars_bigtts": "女",
          "ICL_zh_female_bingjiaojiejie_tob": "女",
          "zh_female_yangmi_mars_bigtts": "女",
          "ICL_zh_female_wenrounvshen_239eff5e8ffa_tob": "女",
        },
        narrator_voice: "zh_male_changtianyi_mars_bigtts",
        concurrency: 4,
      };
      await fs.writeFile(TTS_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
      console.log(`  已保存: ${TTS_CONFIG_FILE}\n`);
    }

    console.log("  配置完成！\n");
    return true;
  } finally {
    rl.close();
  }
}
