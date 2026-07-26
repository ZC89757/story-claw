/**
 * 给一集生成集尾 BGM，输出一个带 BGM 的新文件，不改动原始集视频，作为独立脚本被 solo.ts 用子进程调用。
 *
 * 用法：node --import tsx utils/generate-bgm.ts <原文_clean.txt 的路径>
 * 视频路径按约定从 clean 文本路径推导：{epDir}/{epDir 的文件夹名}.mp4（跟 novelPaths.episodeVideo 的命名规则一致）。
 * 输出：{epDir}/{epDir 的文件夹名}_with_bgm.mp4，原始 {epName}.mp4（无 BGM 版）保持不变。
 *
 * 流程：LLM 读原文分 3-5 段配乐风格 + 锚点 → 按字数占比对总时长分配每段秒数 →
 * 调 ACE-Step 逐段生成 → acrossfade 交叉淡化拼成一条整集 BGM 轨 → 压低音量混进视频，写成新文件。
 *
 * 幂等：带 BGM 的输出文件已存在就直接跳过，不重新调 LLM/ACE-Step。
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG_DIR } from "./run-python.js";
import { EnvHttpProxyAgent } from "undici";

const execFileAsync = promisify(execFile);

// Node 20 内置 fetch 不会自动读取 HTTP_PROXY/HTTPS_PROXY；显式使用环境代理。
// 未配置代理时 EnvHttpProxyAgent 会直接连接，因此本地/服务器部署均可使用。
const fetchDispatcher = new EnvHttpProxyAgent();
const fetchWithProxy = (input: string | URL, init: RequestInit = {}) =>
  fetch(input, { ...init, dispatcher: fetchDispatcher } as RequestInit);

const cleanTextPath = process.argv[2];
if (!cleanTextPath) {
  console.error("用法: node --import tsx utils/generate-bgm.ts <原文_clean.txt 路径>");
  process.exit(1);
}

const EP_DIR         = path.dirname(cleanTextPath);
const EP_NAME        = path.basename(EP_DIR); // 如 "ep01"
const EP_VIDEO_PATH  = path.join(EP_DIR, `${EP_NAME}.mp4`);           // 无 BGM 原始版，只读，不改动
const EP_BGM_VIDEO_PATH = path.join(EP_DIR, `${EP_NAME}_with_bgm.mp4`); // 带 BGM 的新文件
const BGM_DIR        = path.join(EP_DIR, "_bgm");

interface LlmConfig { provider: string; model: string; api_key: string; base_url?: string; }
interface BgmConfig {
  base_url: string; api_key: string;
  crossfade_sec: number; bgm_volume: number;
  min_segments: number; max_segments: number;
}

function loadJson<T>(name: string): T {
  const p = path.join(CONFIG_DIR, name);
  return JSON.parse(fsSync.readFileSync(p, "utf-8"));
}

const llmCfg = loadJson<LlmConfig>("config.json");
const bgmCfg = loadJson<BgmConfig>("bgm_config.json");

// ── 1. LLM 规划分段 ──────────────────────────────────────────────

const BGM_PLAN_SYSTEM = `你是好莱坞级别的影视配乐作曲家（想象 Hans Zimmer / Bear McCreary 那种水平），负责给文生音乐模型（ACE-Step）写 caption。给你一集短剧的原文，请把它分成 3-5 段，每段配一版专业配乐设计。

caption 是决定这段音乐好不好听、有没有节奏的**唯一**输入，必须像真正的作曲家写配乐说明书一样具体，不能笼统。每段必须包含以下全部要素，缺一不可：

1. **配乐流派/参照风格**：具体到子类型，如 "minimalist horror score"、"neo-classical suspense cue"、"Hitchcockian thriller strings"、"John Carpenter synth horror"，不要只写 "suspense" 这种笼统词。
2. **速度术语 + bpm 双写**：意大利语速度术语 + 数字，如 "Andante, 92 bpm"、"Moderato, 108 bpm"、"Largo, 66 bpm"。bpm 必须在 60-140 之间，要有清晰可数的拍子。
3. **明确的节奏型（这是重点，必须具体到"怎么打拍子"，不能只说 steady beat）**：用作曲家会写的节奏描述，例如：
   - "driving ostinato in eighth notes"（八分音符驱动型固定音型）
   - "syncopated pizzicato groove, off-beat accents"（切分拨弦，重音在弱拍）
   - "relentless quarter-note ostinato bassline"（四分音符低音固定音型）
   - "ticking clockwork percussion, 16th-note hi-hat pulse"（十六分音符打点，像钟表滴答）
   - "waltz-like lilting rhythm"（华尔兹摇曳感，需配 3/4 拍）
   - "heartbeat-like timpani pulse on beats 1 and 3"（定音鼓在第1、3拍模拟心跳）
   这条必须写清楚"音符时值 + 落在哪一拍/强弱拍"，不能只说"有节奏"。
4. **拍号**：单独给字段 time_signature（"2"=2/4，"3"=3/4，"4"=4/4，"6"=6/8）。悬疑/不安可以用 3/4 或 6/8 制造"不稳定感"，紧张追逐用 4/4。caption 里也要写一遍拍号（如 "in 4/4"、"in a lurching 6/8"）。
5. **调性**：具体到 "D Minor"、"A Minor"、"C Major" 这种，不要只写 major/minor。
6. **配器严格最多 2 件音色，不能是 3 件**：一件是主奏/氛围乐器，另一件负责第 3 条要求的节奏型（可以是打击乐，也可以是同一件乐器自己弹节奏型，比如 muted piano 自己弹 ostinato 就不需要额外加鼓）——两件搭配好就够，不要为了"丰富"再加第三种音色，音色一多反而乱。都要带演奏法/音色形容词，如 "muted piano"、"tremolo strings"、"pizzicato low strings"、"con sordino violins"、"deep taiko drums"，不要光写乐器名。5 段里必须有 1 件核心乐器贯穿全程保持统一感（比如全程都有 piano，只是演奏法/音区变化），另一件音色可以按段落情绪换。
7. **力度收尾词必须是"平稳、贯穿不变"的，不能是"逐渐变化"的**：这是短剧背景音乐，一段可能要在同一个情绪下垫 1-2 分钟，中途不能有明显的强弱起伏或情绪爬升——那样会和台词节奏打架、显得莫名其妙。
   - **禁止使用**："building intensity"、"crescendo"、"escalating"、"rising tension"、"climax"、"gradually intensifying" 这类会让模型生成"越来越强/有高潮段落"的词。
   - **改用**："steady and unwavering throughout"、"consistent energy, no dynamic swings"、"static intensity, loop-friendly"、"even dynamics from start to end"、"restrained and unchanging mood" 这类明确要求"从头到尾一个状态"的词。
   - 不同段落之间的情绪可以不一样（比如第2段比第1段更紧张），但**每一段内部**必须是平的、稳定的，不能自己搞出一个起承转合。

把以上 7 项拼成一句逗号分隔的英文 tag 串（不是完整句子），大致长度 12-18 个 tag/短语，参考范例：

"neo-classical suspense cue, Andante 92 bpm, in 3/4, relentless quarter-note ostinato in low strings landing on beat 1, D Minor, tremolo strings, muted piano, steady and unwavering throughout, consistent energy, no dynamic swings"

（这句里音色只有 tremolo strings + muted piano 两件，ostinato 节奏型由 strings 自己承担，没有再加第三种打击乐）

反面例子（禁止再犯）：
- "略带疑惑与神秘，弦乐轻颤+木琴点缀，中速，暗藏不安"——太笼统、没有具体节奏型、没有拍号调性。
- "...cold and building dread" / "...escalating anxious crescendo"——这种会让音乐中途自己爬坡变强，不适合垫在台词下面从头放到尾。
- "...tremolo strings, muted piano, sparse timpani hits..."——这是 3 种音色，超出上限，只能留 2 种。

其他规则：
1. 段数 3-5 段，按剧情情绪/场景的自然转折点分段（不用精确到句子，大致合理即可）。
2. 除第一段外，每段给一个 start_anchor：从原文里**逐字摘抄**的一段连续文本，8-20个字，标记这一段配乐从哪里开始起效。要求：
   - 必须是原文中真实存在的连续子串，一字不差（包括标点）。
   - 尽量挑该段情绪/场景转折处附近、且在全文中只出现一次的独特短句，避免选到重复出现的常见词句。
   - 不要跨段落挑（就是不要把两句话中间的空行也包进去）。
3. 第一段不需要 start_anchor（默认从头开始），字段给 null。
4. bpm、time_signature、key_scale 各给一个独立字段，必须和 style 文本里写的一致。
5. 只输出下面这个格式的 JSON，用 \`\`\`bgm-plan 包裹，不要输出任何其他文字：

\`\`\`bgm-plan
[
  {"style": "neo-classical suspense cue, Andante 92 bpm, in 3/4, relentless quarter-note ostinato in low strings landing on beat 1, D Minor, tremolo strings, muted piano, steady and unwavering throughout, consistent energy, no dynamic swings", "bpm": 92, "time_signature": "3", "key_scale": "D Minor", "start_anchor": null},
  {"style": "...", "bpm": 100, "time_signature": "4", "key_scale": "A Minor", "start_anchor": "..."}
]
\`\`\``;

async function callLlm(system: string, user: string): Promise<string> {
  const base = (llmCfg.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
  const resp = await fetchWithProxy(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${llmCfg.api_key}`,
    },
    body: JSON.stringify({
      model: llmCfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
    }),
  });
  if (!resp.ok) {
    throw new Error(`LLM 请求失败: ${resp.status} ${await resp.text()}`);
  }
  const data: any = await resp.json();
  return data.choices[0].message.content as string;
}

interface BgmPlanItem { style: string; bpm: number; time_signature: string; key_scale: string; start_anchor: string | null; }

async function planBgm(cleanText: string): Promise<BgmPlanItem[]> {
  console.log("[1/6] 调 LLM 规划 BGM 分段...");
  const userPrompt = `== 原文 ==\n${cleanText}`;
  const output = await callLlm(BGM_PLAN_SYSTEM, userPrompt);
  const match = output.match(/```bgm-plan\s*([\s\S]*?)```/);
  if (!match) {
    console.error("LLM 原始输出：\n" + output);
    throw new Error("未解析到 bgm-plan JSON 块");
  }
  const plan: BgmPlanItem[] = JSON.parse(match[1].trim());
  console.log(`  拿到 ${plan.length} 段规划：`);
  for (const seg of plan) {
    console.log(`  - anchor=${JSON.stringify(seg.start_anchor)}  style="${seg.style}"`);
  }
  return plan;
}

// ── 2. 锚点定位 + 字数占比算时长 ──────────────────────────────────

interface Segment { style: string; bpm: number; timeSignature: string; keyScale: string; startChar: number; endChar: number; durationSec: number; }

function resolveSegments(cleanText: string, plan: BgmPlanItem[], totalVideoSec: number, crossfadeSec: number): Segment[] {
  const boundaries: number[] = [0];
  let searchFrom = 0;
  for (let i = 1; i < plan.length; i++) {
    const anchor = plan[i].start_anchor;
    if (!anchor) {
      console.warn(`  [警告] 第 ${i + 1} 段缺少 start_anchor，并入上一段`);
      continue;
    }
    const pos = cleanText.indexOf(anchor, searchFrom);
    if (pos === -1) {
      console.warn(`  [警告] 锚点未匹配到，跳过该段边界，并入上一段: "${anchor}"`);
      continue;
    }
    boundaries.push(pos);
    searchFrom = pos + anchor.length;
  }
  boundaries.push(cleanText.length);

  // 去重/排序防御（正常情况下已经是严格递增）
  const uniqBoundaries = [...new Set(boundaries)].sort((a, b) => a - b);

  const totalChars = cleanText.length;
  const segments: Segment[] = [];
  for (let i = 0; i < uniqBoundaries.length - 1; i++) {
    const start = uniqBoundaries[i];
    const end = uniqBoundaries[i + 1];
    const ratio = (end - start) / totalChars;
    let durationSec = ratio * totalVideoSec;
    if (i < uniqBoundaries.length - 2) durationSec += crossfadeSec; // 非最后一段加交叉淡化余量
    durationSec = Math.max(10, Math.round(durationSec)); // ACE-Step 下限 10s
    const src = plan[i] ?? plan[0];
    segments.push({
      style: src.style, bpm: src.bpm, timeSignature: src.time_signature, keyScale: src.key_scale,
      startChar: start, endChar: end, durationSec,
    });
  }
  return segments;
}

// ── 3. ffmpeg/ffprobe 工具 ──────────────────────────────────────

async function getMediaDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath,
  ]);
  return parseFloat(stdout.trim());
}

// ── 4. 调 ACE-Step 生成单段 BGM ──────────────────────────────────

async function acestepFetch(pathname: string, body: any): Promise<any> {
  const resp = await fetchWithProxy(`${bgmCfg.base_url}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${bgmCfg.api_key}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ACE-Step ${pathname} 失败: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function generateBgmSegment(seg: Segment, outPath: string): Promise<void> {
  if (fsSync.existsSync(outPath)) {
    console.log(`    已存在，跳过: ${path.basename(outPath)}`);
    return;
  }
  const prompt = `${seg.style}, instrumental, no vocals, no lyrics, film score`;
  const submit = await acestepFetch("/release_task", {
    prompt,
    bpm: seg.bpm,
    time_signature: seg.timeSignature,
    key_scale: seg.keyScale,
    audio_duration: seg.durationSec,
    inference_steps: 8,
    batch_size: 1,
    audio_format: "mp3",
    thinking: true, // 打开 5Hz LM，让它先规划 audio_code 再交给 DiT，推理会变慢但质量更好
  });
  const taskId = submit.data.task_id;

  let audioRelPath: string | null = null;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const q = await acestepFetch("/query_result", { task_id_list: [taskId] });
    const item = q.data[0];
    if (item.status === 1) {
      const results = JSON.parse(item.result);
      audioRelPath = results[0].file; // "/v1/audio?path=..."
      break;
    }
    if (item.status === 2) {
      throw new Error(`ACE-Step 生成失败: ${item.progress_text ?? JSON.stringify(item)}`);
    }
  }
  if (!audioRelPath) throw new Error("ACE-Step 生成超时（360s，thinking 模式首次加载 LLM 可能较慢）");

  const resp = await fetchWithProxy(`${bgmCfg.base_url}${audioRelPath}`, {
    headers: { "Authorization": `Bearer ${bgmCfg.api_key}` },
  });
  if (!resp.ok) throw new Error(`下载音频失败: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(outPath, buf);
  console.log(`    生成完成: ${path.basename(outPath)} (目标 ${seg.durationSec}s)`);
}

// ── 5. 交叉淡化拼接 ──────────────────────────────────────────────

async function crossfadeConcat(segmentPaths: string[], crossfadeSec: number, outPath: string): Promise<void> {
  if (segmentPaths.length === 1) {
    await fs.copyFile(segmentPaths[0], outPath);
    return;
  }
  let current = segmentPaths[0];
  for (let i = 1; i < segmentPaths.length; i++) {
    const next = segmentPaths[i];
    const isLast = i === segmentPaths.length - 1;
    const tmpOut = isLast ? outPath : path.join(BGM_DIR, `_xfade_tmp_${i}.mp3`);
    await execFileAsync("ffmpeg", [
      "-y", "-i", current, "-i", next,
      "-filter_complex", `acrossfade=d=${crossfadeSec}:c1=tri:c2=tri`,
      "-c:a", "libmp3lame", "-q:a", "2",
      tmpOut,
    ]);
    current = tmpOut;
  }
}

// ── 6. 混音进视频（输出新文件，原始集视频不动）──────────────────────

async function mixBgmIntoVideo(videoPath: string, bgmTrackPath: string, outPath: string, bgmVolume: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", bgmTrackPath,
    "-filter_complex",
    `[1:a]volume=${bgmVolume}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    outPath,
  ]);
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  if (fsSync.existsSync(EP_BGM_VIDEO_PATH)) {
    console.log(`[BGM] ${path.basename(EP_BGM_VIDEO_PATH)} 已存在，跳过`);
    return;
  }
  if (!fsSync.existsSync(EP_VIDEO_PATH)) {
    throw new Error(`找不到集视频: ${EP_VIDEO_PATH}`);
  }

  await fs.mkdir(BGM_DIR, { recursive: true });

  const cleanText = await fs.readFile(cleanTextPath, "utf-8");

  const planPath = path.join(BGM_DIR, "bgm_plan.json");
  let plan: BgmPlanItem[];
  if (fsSync.existsSync(planPath)) {
    console.log("[1/6] bgm_plan.json 已存在，跳过 LLM 调用，直接复用");
    plan = JSON.parse(await fs.readFile(planPath, "utf-8"));
  } else {
    plan = await planBgm(cleanText);
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), "utf-8");
  }

  console.log("[2/6] 量取整集视频时长...");
  const totalVideoSec = await getMediaDuration(EP_VIDEO_PATH);
  console.log(`  ${EP_NAME}.mp4 总时长: ${totalVideoSec.toFixed(1)}s`);

  console.log("[3/6] 锚点定位，按字数占比算每段时长...");
  const segments = resolveSegments(cleanText, plan, totalVideoSec, bgmCfg.crossfade_sec);
  for (const [i, seg] of segments.entries()) {
    const chars = seg.endChar - seg.startChar;
    console.log(`  段${i + 1}: 字符[${seg.startChar},${seg.endChar}) 共${chars}字  目标时长=${seg.durationSec}s  style="${seg.style}"`);
  }

  console.log("[4/6] 逐段生成 BGM（调 ACE-Step，可能需要几分钟）...");
  const segPaths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const outPath = path.join(BGM_DIR, `seg${String(i).padStart(2, "0")}.mp3`);
    console.log(`  [段${i + 1}/${segments.length}] bpm=${segments[i].bpm} ${segments[i].timeSignature}/? key=${segments[i].keyScale}\n    ${segments[i].style}`);
    await generateBgmSegment(segments[i], outPath);
    segPaths.push(outPath);
  }

  console.log("[5/6] 交叉淡化拼接整条 BGM 轨...");
  const trackPath = path.join(BGM_DIR, "_bgm_track.mp3");
  await crossfadeConcat(segPaths, bgmCfg.crossfade_sec, trackPath);
  const trackDur = await getMediaDuration(trackPath);
  console.log(`  BGM 轨总时长: ${trackDur.toFixed(1)}s（视频总时长 ${totalVideoSec.toFixed(1)}s）`);

  console.log("[6/6] 混音进视频（输出新文件）...");
  await mixBgmIntoVideo(EP_VIDEO_PATH, trackPath, EP_BGM_VIDEO_PATH, bgmCfg.bgm_volume);

  console.log(`\n完成！无 BGM 版: ${EP_VIDEO_PATH}`);
  console.log(`      带 BGM 版: ${EP_BGM_VIDEO_PATH}`);
}

main().catch((err) => {
  console.error("[BGM] 生成失败:", err);
  process.exit(1);
});
