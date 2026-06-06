/**
 * 流水线执行逻辑
 *
 * 四个阶段，各由独立 sub-agent 执行：
 *   visualPreset — 画面预设：逐句标注场景/人物/镜头/情绪等画面语言，输出 画面预设.txt
 *   archive      — 资源建档：读取画面预设，识别角色/场景，生成参考图
 *   segment      — 剧本分场：读取画面预设，按场景切分为剧本文件（含画面标注）
 *   storyboard   — 分镜制作：合成帧 → 分镜导演 → 分镜图
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { runSubAgent } from "../agent.js";
import { writeTool } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { novelPaths } from "../utils/paths.js";
import type { NovelSelection } from "../ui/select.js";

import { listResourcesTool } from "../tools/list-resources.js";
import { resourceDetailTool } from "../tools/resource-detail.js";
import { loadSegmentData } from "../tools/load-segment-data.js";
import { generateCharacterTool } from "../tools/generate-character.js";
import { generateSceneTool } from "../tools/generate-scene.js";
import { assignVoices } from "./render.js";

// ── Sub-agent 系统提示 ────────────────────────────────────────

const VISUAL_PRESET_SYSTEM = `你是分镜预设专员。任务：为小说原文的每一句话标注画面语言，辅助后续分镜制作。

标注规则：
- 以中文句终标点（。！？…）为单位切句
- 每句原文后紧跟一个【】块，原文逐字保留，不得改写
- 【】块内用"|"分隔各维度，格式：场景 | 人物 | 景别 | 角度 | 镜头运动 | 光影 | 情绪 | 语言 | 独白
- 各维度说明：
  场景：当前所在地点及环境状态
  人物：出现的角色、各自位置与动作（无人物则写"无"）
  景别：远景/全景/中景/近景/特写 之一
  角度：平视/俯视/仰视/斜角 等
  镜头运动：固定/推/拉/摇/跟/升/降 等
  光影：光源方向、氛围、明暗
  情绪：角色的情绪状态（无人物则写"无"）
  语言：原文中明确出现说话动作时才填，如：说、喊、问、答、偷偷说、大声说、对xx说，或句子带引号（"…"/"…"）；否则写"无"
  独白：原文中明确出现内心活动关键词时才填，如：心想、心里想、心中暗想；否则写"无"

步骤：
1. 逐句处理原文，按上述规则生成标注内容
2. 用内置 write 工具将全部内容写入 task 指定的输出路径
3. 在最终回复末行写明：画面预设路径: <输出路径>

完成后直接结束，不要询问用户任何问题。`;

const ARCHIVE_SYSTEM = `你是资源建档专员。根据小说原文和已有资源，完成以下分析并输出结果。不要停下来询问，直接完成所有步骤。

== 概念定义 ==

硬场景：指这个地点本身的样子——建筑结构、家具陈设、空间布局等，基本不会随剧情变动。
软场景：指某个具体剧情时刻里，场景里会随时变化的东西——光线、天气、散落的物体、临时道具等。
原型图：角色穿着符合小说时代背景的普通便服时的样子，记录基础体貌，每角色只生成一次。
造型：角色在某段剧情里出现的、服装或随身道具发生显著变化的外观状态。
      「外观」只包含：服装、随身道具。以下一律不算外观变化，不产生新造型：
        - 情绪、表情、神情（如沉迷、专注、愤怒、哭泣）
        - 动作、姿态（如奔跑、坐下、低头）
        - 所处场景、地点（如在地下室、在教室）
        - 光线、时间、氛围（如昏暗、冷光、夜晚）
      判定方法：只问「他穿的、带的东西变了吗」。变了才是造型；只是换了地方/心情/在做某事，不是造型。
      例：开学报到=背包拉行李箱；受伤后=坐轮椅；打架后=衣服脏破狼狈。
      反例（不生成）：热情推销、被吓跑、愤怒、哭泣、沉迷地玩电脑、在昏暗灯光下专注工作——这些只是情绪/动作/场景，外观未变。
造型图：角色处于某造型时的参考图，基于原型图图生图生成，只在造型显著变化时生成。

== 步骤 ==

1. 对原文中每一个角色：
   - 不在已有列表中：记入 new_characters
   - 已在列表中：用 resource_detail 检查是否有符合上述造型定义的新阶段（服装或随身道具发生显著变化），有则记入 existing_character_stages，无则跳过
   - 参考「已有资源」中的「角色现有图片」列表：若该角色已有能覆盖当前剧情的图片（含用户手动提供的参考图，如「少年时期」「青年时期」），则不要再生成意思相近的造型

2. 对原文中每一个场景：
   - 不在已有列表中：记入 new_scenes
   - 已在列表中：用 resource_detail 检查是否有新的软场景阶段，有则记入 existing_scene_stages，无则跳过

3. 在最终回复的末尾，严格按以下格式输出 JSON 块（不要省略任何字段）：

\`\`\`archive-tasks
{
  "scene_names": ["场景名1", "场景名2"],
  "new_characters": [
    {
      "name": "角色名",
      "gender": "男 或 女",
      "prompt": "基础体貌描述：年龄、身形、面部特征、发型等",
      "stages": [
        { "stage": "造型阶段名", "prompt": "本阶段服装与随身道具的变化，仅此而已" }
      ]
    }
  ],
  "new_scenes": [
    {
      "location_name": "场景名（与 JSON 文件名完全一致）",
      "base_prompt": "固定环境描述：建筑结构、家具陈设、空间布局（无人物，无光线时间）",
      "initial_stage": "初始软场景阶段名，如「入学第一天午后」",
      "initial_soft": "初始软场景描述：光线、时间、情节相关物件"
    }
  ],
  "existing_character_stages": [
    {
      "name": "已有角色名",
      "stages": [
        { "stage": "新造型阶段名", "prompt": "本阶段服装与随身道具的变化，仅此而已" }
      ]
    }
  ],
  "existing_scene_stages": [
    {
      "location_name": "已有场景名",
      "base_prompt": "原有的固定环境描述（从 resource_detail 读取）",
      "new_stage": "新软场景阶段名",
      "new_soft": "新软场景描述：光线、时间、情节相关物件"
    }
  ]
}
\`\`\`

场景名必须与写入的场景 JSON 文件名完全一致。new_characters 只包含本章新出现的角色，existing_character_stages / existing_scene_stages 只包含有新内容的已有资源（无新内容则为空数组）。

造型 stages[].prompt 的硬约束：只允许写服装与随身道具（如「白衬衫、戴黑框眼镜」）。禁止出现：具体年龄数字（如「16岁」，年龄已由原型图体现）、情绪/神情（如「专注」「沉迷」）、动作姿态、所处场景地点、光线时间氛围。若某角色本阶段服装与道具相比原型并无变化，则不要为其生成任何 stage。`;

const SEGMENT_SYSTEM = `你是剧本分场专员。任务：将章节原文按场景切分，原文逐字保留，不改写。

切分规则：
- 每个场景以 ## 场景X：{场景名} · {时间/地点} 开头
- 场景名必须与 task 中场景列表的名称完全一致
- 时间/地点 补充该场景在原文中对应的时间和具体地点描述
- 原文段落逐字保留，不得改写、删减或添加任何内容
- 若原文某段同时涉及多个场景，按叙事逻辑拆分到对应场景下

步骤：
1. 将原文按上述规则切分，用内置 write 工具将每个场景保存为单独的 .md 文件
2. write 工具的 path 参数只写文件名「{场景名}.md」，不要带任何目录前缀（工作目录已设为剧本目录）
3. 文件名中的场景名必须与 task「场景列表」中的名称逐字完全一致，禁止自创、改写、编号或合并场景名
4. 在最终回复末行写明：剧本目录已写入

完成后直接结束，不要询问用户任何问题。`;

const STORYBOARD_SYSTEM = `你是分镜导演。任务：为一个场景的完整剧本设计分镜序列，输出可直接用于生图和生视频的 prompt。

== 基本概念 ==

剧本中每句话对应一个 group。
每个 group 内有一个或多个 panel（分镜），每个 panel 代表原文时间线上的一个时刻。

== 【】画面预设说明 ==

剧本每句话后的【】块格式：场景 | 人物 | 景别 | 角度 | 镜头运动 | 光影 | 情绪 | 语言 | 独白

各字段含义及在提示词中的用途：
- 场景：当前地点及环境状态 → image_prompt 背景描述的基础
- 人物：出现角色的位置与动作 → image_prompt 中人物姿态的参考
- 景别：远景/全景/中景/近景/特写 → panel 的 shot_type，决定画面中人物与背景的比例
- 角度：拍摄角度（平视/俯视/仰视等）→ image_prompt 中的镜头角度描述
- 镜头运动：固定/推/拉/摇/跟等 → video_prompt 中的镜头运动方式
- 光影：光源、氛围、明暗 → image_prompt 中的光线描述
- 情绪：角色情绪状态 → image_prompt 中表情/肢体语言，video_prompt 中情绪节奏
- 语言：角色说出的台词（"无"则忽略）→ video_prompt 中描述说话动作（语气节奏与台词内容匹配）
- 独白：角色内心独白（"无"则忽略）→ 以画外音形式呈现，video_prompt 中明确要求人物嘴部不动，通过细微表情或无意识肢体动作体现内心状态

== 漫画分镜三定律 ==

定律一：一格一事
一个 panel 只传递一个信息：一个动作、一句话、一个表情、一个环境细节。超过一个就拆格。

定律二：对话必须有载体
有台词的 panel，必须展示说话人的状态（表情、姿势）。

- 台词原文写入该时刻 panel 的 video_prompt，不得改写或省略
- 不要多拆（同一句话不拆成两格），不要少拆（两句话不压进一格）

定律三：转折单独占格
情绪变化、信息揭示、意外事件必须独立成一个 panel。

定律四：无效信息不成格
每个 panel 必须承载原文中的一个有效信息点（台词、动作、情绪变化、空间关系、道具细节）。没有有效信息的 panel 不生成——多余的格只会画蛇添足、拖慢节奏。

== image_prompt 与 video_prompt 的关系 ==

工作流：先由 image_prompt 生成静态参考图，再将参考图 + video_prompt 输入视频模型生成视频。
因此：
- image_prompt 负责描述静态画面的完整细节：背景环境、人物位置与姿态、景别角度、光线氛围
- video_prompt 基于 image_prompt 已建立的画面，专注描述：镜头运动 + 人物动态变化 + 情绪节奏
- video_prompt 不重复 image_prompt 中已有的静态描述，只补充动态信息
- 若【语言】有内容：只能在一个panel的video_prompt 中写语言的原文。
- 若【独白】有内容：video_prompt 注明为画外音，人物嘴部不动，通过细微表情或无意识肢体动作体现内心状态
- 若【语言】和【独白】均为"无"：在 video_prompt 末尾明确注明"No dialogue or voiceover."

== image_prompt 中的人物身份内联标注 ==

image_prompt 描述人物时，凡出现在「角色名单」中的角色，必须用 [角色名·阶段] 内联标注身份，紧贴该人物的外貌/姿态描述：
- 角色名：与角色名单中的名称完全一致；第一人称"我"按剧情对应到名单中的主角
- 阶段：你根据剧情上下文对该角色当前人生阶段的简短概括（如「少年时期」「童年」「青年」「受伤后」）。无需精确，不必与任何文件名一致——它只是给后续选图环节的提示
- 示例：特写[黄仁勋·少年时期]的手紧握乒乓球拍，手指肌肉线条清晰，暖黄回忆光线…
- 不在名单中的人物（无参考图）正常文字描述，不要加方括号
- 方括号只标身份，动作/景别/光线/氛围等照常写在 image_prompt 里

== 主镜头（每个 group 的第一个 panel）==

景别根据内容选择：
- 多人互动/对话 → 全景或中景，展示人物相对位置
- 单人动作 → 中景
- 环境/空间描写 → 远景或全景
- 情绪/心理描写 → 近景

== 衔接约束 ==

组内：
- 不允许连续两个景别+角度完全相同的 panel
- 不允许相邻两个 panel 的镜头运动方式相同（固定镜头无运镜，不受此限制）
- panel 顺序按叙事时间排列

组间：
- 每个 group 结束时记录 end_positions（场景内所有在场人物的位置与朝向）
- 下一个 group 的第一个 panel 从上一组的 end_positions 出发
- 相邻两组之间，后一组第一个 panel 的景别以及运镜不能与前一组最后一个 panel 相同

== 输出 JSON ==

{
  "scene": "场景名",
  "groups": [
    {
      "text": "原文句子（含【画面预设】标注）",
      "end_positions": "句末所有在场人物的位置与朝向描述",
      "panels": [
        {
          "shot_type": "景别",
          "is_continuation": false,
          "image_prompt": "完整生图描述：场景背景细节 + 人物位置与姿态（名单角色用[角色名·阶段]标注身份）+ 景别角度 + 光线氛围",
          "video_prompt": "基于已生成图片的动态描述：镜头运动 + 人物动作变化 + 情绪节奏（含台词/独白对应的说话或表情动作）"
        }

is_continuation 规则：
- true：满足以下全部条件时才可标 true：
  1. 镜头运动为推镜（push / zoom in），取景范围只缩小不扩大
  2. 根据上一个 panel 的 video_prompt 推断其尾帧内容：若上一 panel 描述了人物跑开、转身离开、背对镜头、大幅移动等情况，则尾帧大概率不含人脸，本 panel 若需展示人脸则不得标 true
  3. 本 panel 所需的人脸信息不超过上一 panel 尾帧中已有的信息——即本 panel 是对上一 panel 画面的局部推近，而非引入新的面部角度或表情
  4. 例外：若上一 panel 的 video_prompt 中明确描述了两人对话且含有人脸/表情信息，本 panel 是对其中某人的推镜特写，则可标 true
- false：其他所有情况（硬切、新人物、新场景、情绪切换、转身、人物移出画面后再出现等）
      ]
    }
  ]
}

步骤：
1. 通读整个场景剧本，理解空间布局和人物关系
2. 从第一句开始，逐句处理：
   a. 根据规则规划该句的所有 panel
   b. 立即调用 append_group 工具，传入该 group 的完整 JSON 字符串
   c. 处理下一句
3. 所有句子处理完毕后结束

注意：
- 每句必须处理完立即调用 append_group，不要等全部处理完再统一调用
- append_group 的 content 参数是单个 group 的 JSON 字符串，格式：
  {"text":"...","end_positions":"...","panels":[{"shot_type":"...","is_continuation":false,"image_prompt":"...","video_prompt":"..."}]}

完成后直接结束，不要询问用户任何问题。`;

// ── VisualPreset：画面预设 ────────────────────────────────────

export async function visualPreset(sel: NovelSelection): Promise<string> {
  const progressContent = await fs.readFile(novelPaths.progress(sel.novelName), "utf-8").catch(() => JSON.stringify({ next_chapter: 1 }));
  const progress = JSON.parse(progressContent);
  const nextChapter: number = progress.next_chapter ?? 1;
  const novelFolder: string = progress.source_path;

  const filename = (await fs.readdir(novelFolder)).find(
    (f) => new RegExp(`^第${nextChapter}章`).test(f),
  );
  if (!filename) throw new Error(`找不到第${nextChapter}章文件`);

  const chapterText = await fs.readFile(path.join(novelFolder, filename), "utf-8");
  const outputPath = novelPaths.visualPreset(sel.novelName, sel.episode);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await runSubAgent(
    [],
    VISUAL_PRESET_SYSTEM,
    [
      `输出路径：${outputPath}`,
      ``,
      `== 章节原文 ==`,
      chapterText,
    ].join("\n"),
    "[画面预设]",
    [writeTool],  // 只需要写文件，禁用 read
  );

  // 验证文件已生成
  await fs.access(outputPath);
  return outputPath;
}

// ── Archive：资源建档 ─────────────────────────────────────────

export interface ArchiveResult {
  sceneNames: string[];
}

export async function archive(sel: NovelSelection, visualPresetPath: string): Promise<ArchiveResult> {
  const presetText = await fs.readFile(visualPresetPath, "utf-8");
  const listResult = await listResourcesTool.execute("", { novel_name: sel.novelName });
  const listText   = (listResult.content[0] as any).text as string;

  const charsDir = novelPaths.charactersDir(sel.novelName);

  const taskPrompt = [
    `== 小说原文（含画面预设标注）==`,
    presetText,
    ``,
    `== 已有资源 ==`,
    listText,
    ``,
    `请根据以上信息，分析「${sel.novelName}」本章涉及的角色和场景，输出 archive-tasks JSON 块。`,
  ].join("\n");

  const output = await runSubAgent(
    [resourceDetailTool],
    ARCHIVE_SYSTEM,
    taskPrompt,
    "[资源建档]",
    [],  // 不暴露 write/read，角色和场景 JSON 由工具代码自动写入
  );

  // 解析 agent 输出的 archive-tasks JSON 块
  let tasks: any = null;
  const match = output.match(/```archive-tasks\s*([\s\S]*?)```/);
  if (match) {
    try { tasks = JSON.parse(match[1].trim()); } catch { /* 忽略 */ }
  }

  if (!tasks) {
    console.log("[资源建档] 未解析到 archive-tasks，跳过图像生成");
    return { sceneNames: [] };
  }

  const sceneNames: string[]         = tasks.scene_names ?? [];
  const newChars: any[]              = tasks.new_characters ?? [];
  const newScenes: any[]             = tasks.new_scenes ?? [];
  const existingStages: any[]        = tasks.existing_character_stages ?? [];
  const existingSceneStages: any[]   = tasks.existing_scene_stages ?? [];

  // ── 阶段一：为本章新角色批量分配音色（生图前，一次写 voice_map，无并发）──
  await assignVoices(
    sel.novelName,
    newChars.map((c: any) => ({ name: c.name, base_prompt: c.prompt, gender: c.gender })),
  );

  // ── Step 1：原型图 + 场景底图 + 已有场景新软阶段，完全并行 ──────
  await Promise.all([
    ...newChars.map((c: any) =>
      generateCharacterTool.execute("", {
        novel_name: sel.novelName,
        name:       c.name,
        prompt:     c.prompt,
        ethnicity:  sel.ethnicity,
      }),
    ),
    ...newScenes.map((s: any) =>
      generateSceneTool.execute("", {
        novel_name:    sel.novelName,
        location_name: s.location_name,
        base_prompt:   s.base_prompt,
        initial_stage: s.initial_stage,
        initial_soft:  s.initial_soft,
      }),
    ),
    ...existingSceneStages.map((s: any) =>
      generateSceneTool.execute("", {
        novel_name:    sel.novelName,
        location_name: s.location_name,
        base_prompt:   s.base_prompt,
        initial_stage: s.new_stage,
        initial_soft:  s.new_soft,
      }),
    ),
  ]);

  // ── Step 2：造型图（依赖原型图，在 Step 1 完成后并行）────────────
  const stageTasks: Array<{ name: string; stage: string; prompt: string }> = [
    ...newChars.flatMap((c: any) =>
      (c.stages ?? []).map((st: any) => ({
        name:  c.name,
        stage: st.stage,
        prompt: st.prompt,
      })),
    ),
    ...existingStages.flatMap((c: any) =>
      (c.stages ?? []).map((st: any) => ({
        name:  c.name,
        stage: st.stage,
        prompt: st.prompt,
      })),
    ),
  ];

  if (stageTasks.length > 0) {
    await Promise.all(
      stageTasks.map((st) =>
        generateCharacterTool.execute("", {
          novel_name: sel.novelName,
          name:       st.name,
          prompt:     st.prompt,
          ethnicity:  sel.ethnicity,
          stage:      st.stage,
        }),
      ),
    );
  }

  return { sceneNames };
}

// ── Segment：剧本分场 ─────────────────────────────────────────

export async function segment(sel: NovelSelection, archiveResult: ArchiveResult, visualPresetPath: string): Promise<string> {
  const expectedDir = novelPaths.scriptsDir(sel.novelName, sel.episode);
  await fs.mkdir(expectedDir, { recursive: true });  // cwd 必须先存在

  const loadText = await loadSegmentData(sel.novelName, sel.episode, archiveResult.sceneNames, visualPresetPath);

  await runSubAgent(
    [],
    SEGMENT_SYSTEM,
    [
      `请为小说「${sel.novelName}」第${sel.episode}集切分剧本。`,
      ``,
      loadText,
    ].join("\n"),
    "[剧本分场]",
    [writeTool],  // 只需要写文件，禁用 read
    expectedDir,  // 工作目录设为剧本目录，agent 写裸文件名即落入此处
  );

  // 验证至少有一个场景文件被写入
  try {
    const files = await fs.readdir(expectedDir);
    if (!files.some((f) => f.endsWith(".md"))) {
      throw new Error("目录存在但没有 .md 文件");
    }
  } catch {
    throw new Error(`剧本分场完成但目录不存在或为空: ${expectedDir}`);
  }
  return expectedDir;
}

// ── Storyboard 进度 ───────────────────────────────────────────

export interface StoryboardProgress {
  done: number;
  total: number;
}

// ── Storyboard：分镜制作（每个场景 .md 文件对应一个 agent，并行）────────────

export async function storyboard(
  sel: NovelSelection,
  scriptsDir: string,
  onProgress?: (p: StoryboardProgress) => void,
): Promise<void> {
  const files = (await fs.readdir(scriptsDir)).filter((f) => f.endsWith(".md"));

  // 构建角色名单（所有场景共用）：列出有参考图的角色，供分镜 agent 内联标注身份
  const charsDir = novelPaths.charactersDir(sel.novelName);
  const allCharFiles = await fs.readdir(charsDir).catch(() => []);
  const charPngs = allCharFiles.filter((f) => f.endsWith(".png"));
  const rosterLines: string[] = [];
  for (const cf of allCharFiles.filter((f) => f.endsWith(".json"))) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(charsDir, cf), "utf-8"));
      const name = data.name ?? path.basename(cf, ".json");
      if (charPngs.some((f) => f.startsWith(`${name}_`))) {
        rosterLines.push(`- ${name}：${data.base_prompt ?? ""}`);
      }
    } catch { /* 跳过解析失败 */ }
  }
  const rosterText = rosterLines.length ? rosterLines.join("\n") : "（无）";

  const progress: StoryboardProgress = { done: 0, total: files.length };
  onProgress?.(progress);

  await Promise.all(
    files.map(async (filename) => {
      const sceneName  = filename.replace(/\.md$/, "");
      const scriptPath = path.join(scriptsDir, filename);
      const jsonlPath  = novelPaths.storyboardJsonl(sel.novelName, sel.episode, sceneName);
      const scriptContent = await fs.readFile(scriptPath, "utf-8");

      // 确保 storyboards/ 目录存在
      await fs.mkdir(path.dirname(jsonlPath), { recursive: true });

      // 每个场景创建独立的 appendGroupTool 实例，路径通过闭包注入
      const appendGroupTool: ToolDefinition = {
        name: "append_group",
        label: "追加分镜组",
        description: "追加一个 group 的分镜 JSON，并自动在剧本中标记该句为已处理",
        parameters: Type.Object({
          content: Type.String({ description: "该 group 的完整 JSON 字符串" }),
        }),
        execute: async (_toolCallId: string, { content }: { content: string }) => {
          // 1. 规范化 JSON（parse + stringify 确保转义正确、单行输出）
          let normalized: string;
          try {
            normalized = JSON.stringify(JSON.parse(content));
          } catch {
            return { content: [{ type: "text" as const, text: "ERROR: invalid JSON, please fix escaping and retry" }], details: {} };
          }
          await fs.appendFile(jsonlPath, normalized + "\n", "utf-8");

          // 2. 找第一个未标记的非空非标题行，追加"(已处理)"
          const lines = (await fs.readFile(scriptPath, "utf-8")).split("\n");
          const idx = lines.findIndex(
            (l) => l.trim() && !l.startsWith("#") && !l.trim().startsWith("【") && !l.includes("(已处理)"),
          );
          if (idx !== -1) {
            lines[idx] += "(已处理)";
            await fs.writeFile(scriptPath, lines.join("\n"), "utf-8");
          }

          return { content: [{ type: "text" as const, text: "OK" }], details: {} };
        },
      };

      await runSubAgent(
        [appendGroupTool],
        STORYBOARD_SYSTEM,
        [
          `场景名：${sceneName}`,
          ``,
          `== 本剧角色名单（这些角色都有参考图，画面中出现时须用 [角色名·阶段] 内联标注）==`,
          rosterText,
          ``,
          `== 场景剧本 ==`,
          scriptContent,
        ].join("\n"),
        `[分镜:${sceneName}]`,
        [],  // 不给 write/read，只用 append_group
      );

      progress.done++;
      onProgress?.(progress);
    }),
  );
}

// ── Render：分镜渲染 ──────────────────────────────────────────────
export { renderScene } from "./render.js";
export type { RenderProgress, SceneRenderResult } from "./render.js";
