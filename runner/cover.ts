import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { readTool } from "@mariozechner/pi-coding-agent";
import { runSubAgent } from "../agent.js";
import type { NovelSelection } from "../ui/select.js";
import { generateImage } from "../utils/image-gen.js";
import { novelPaths } from "../utils/paths.js";

interface CoverCandidate {
  id: string;
  imagePath: string;
  sceneName?: string;
  groupIndex?: number;
  panelIndex?: number;
  text?: string;
  imagePrompt?: string;
}

interface CoverPlan {
  title: string;
  reference_id: string | null;
  landscape_prompt: string;
  portrait_prompt: string;
  reason: string;
}

const STORY_COVER_SYSTEM = `你是短剧单集封面策划智能体。你只负责从候选分镜中选择参考图，并为横版、竖版封面编写可直接交给强大图像生成模型的中文提示词。

规则：
1. 通读全部候选的剧情文字和 image_prompt，选择最能代表本集核心人物、冲突、悬念或标志性场景的一张；不能只选漂亮但无代表性的过场。
2. 只能返回候选清单中的 reference_id，不得编造路径或 ID。
3. 标题必须使用任务中给出的“指定封面标题”，逐字保留，不得改写。
4. 横版与竖版使用同一参考图，但必须分别设计构图，不是机械裁切；保留参考图中的人物身份、服装、时代和场景连续性。
5. 提示词要明确要求把指定标题直接写在封面上，中文必须清晰、准确、完整；除该标题外不得出现其他文字、水印或角标。
6. 画面主体清楚、层次少、缩略图尺寸仍易读。不要描述模型已能识别的常识性品牌外观。
7. 只输出一个 JSON 代码块，不要解释：
\`\`\`json
{"title":"指定封面标题","reference_id":"P001","landscape_prompt":"...","portrait_prompt":"...","reason":"..."}
\`\`\``;

const ESSAY_COVER_SYSTEM = `你是议论文、科普和科技资讯单集封面策划智能体。你负责理解全文、拟标题、判断项目 resource 图片是否适用，并为横竖封面编写可直接交给强大图像生成模型的中文提示词。

规则：
1. 先通读全文，识别文章描述的核心事件主体、主要公司或产品、可用的知名公众人物，以及最具体的变化、冲突或结果。封面必须能用一句“谁在做什么”讲清文章含义，不能只陈列元素。
2. 标题只写事件本身，禁止添加“第N章”“第N集”。最多约 12 个汉字，必须具体、准确、不宽泛，直接说明这篇文章独有的事件。
3. resource 候选存在时，可用 read 工具查看图片。只有图片与本章核心主题真正匹配时才返回其 reference_id；没有合适图片必须返回 null，走文生图。
4. 画面只能有 2–3 个主要视觉主体。文章提到明确公司或产品时，对应公司/产品 logo 必须成为清晰可辨的主体之一；logo 可以拟人化、长出手脚并执行动作，但必须保持品牌辨识。适合使用知名公众人物时可直接写人物姓名，无需描述外貌。
5. 必须设计一个具体叙事动作来表达文章含义。例如 OpenAI 降价可画 Sam Altman 手持一张印有 GPT logo 和“降价”的纸；ChatGPT 越狱可把 ChatGPT logo 关进笼子，让拟人化 logo 从里面伸手开锁。示例只说明叙事方式，不得套用到无关文章。禁止用多个 logo 并排、参数卡片散落或抽象符号堆砌代替动作。
6. 背景必须是从四角到中心颜色完全一致的浅色纯色背景，优先纯白、米白、浅黄或品牌浅色；禁止深色背景。背景不得有渐变、中心提亮、暗角、辉光、纹理、复杂环境、城市或深空。
7. 主体必须有真实的体积感和空间纵深，采用写实商业广告摄影或高品质三维电影海报质感，而不是动漫、卡通、扁平插画。使用清晰的前景、中景层次、透视关系、材质细节和自然柔和的接触阴影；允许主体自身受光和小范围落地阴影，但背景仍保持均匀纯色。logo 拟人化时也应做成立体实体标志，而不是二维卡通图标。
8. 严禁廉价 AI 视觉效果：粒子、光点、光丝、光轨、光带、光环、辉光、全息、气态或雾状发光、霓虹、镜头光斑、赛博效果、蓝紫科技光、漂浮数据卡、发光球体、通用机器人、抽象立方体。也禁止使用“电影级光效”“未来科技感”等空泛词汇。纵深只能来自真实透视、主体遮挡关系、材质和自然摄影光影，不能依靠特效。
9. 画面应像简洁、有明确动作关系的高品质商业摄影或电影宣传海报。标题可放顶部或中央，由构图决定，但必须是第一视觉层级：醒目粗体、高对比、缩略图清晰，不能放在不醒目的底部，也不能被任何主体遮挡。
10. 横版和竖版必须采用完全相同的核心创意、主体和动作，只调整空间排列，不能分别发明两套画面。提示词必须要求标题中文清晰准确；除标题及叙事必需的一个短词外，不得出现其他文字、水印或角标。
11. 只输出一个 JSON 代码块，不要解释：
\`\`\`json
{"title":"简洁标题","reference_id":null,"landscape_prompt":"...","portrait_prompt":"...","reason":"..."}
\`\`\``;

function parsePlan(output: string): CoverPlan {
  const match = output.match(/```json\s*([\s\S]*?)```/i);
  if (!match) throw new Error("封面智能体未返回 JSON 代码块");
  const value = JSON.parse(match[1].trim());
  if (
    typeof value?.title !== "string"
    || (value.reference_id !== null && typeof value.reference_id !== "string")
    || typeof value?.landscape_prompt !== "string"
    || typeof value?.portrait_prompt !== "string"
    || typeof value?.reason !== "string"
  ) {
    throw new Error("封面智能体返回字段不完整");
  }
  return value as CoverPlan;
}

async function locateChapterFile(sel: NovelSelection): Promise<string | null> {
  const files = await fs.readdir(sel.sourcePath);
  const pattern = new RegExp(`^第${sel.nextChapter}章`);
  const filename = files.find((name) => pattern.test(name) && name.toLowerCase().endsWith(".txt"));
  return filename ?? null;
}

function cleanNovelName(name: string): string {
  return name.replace(/^work\s+/i, "").trim();
}

async function buildStoryCandidates(sel: NovelSelection): Promise<CoverCandidate[]> {
  const storyboardsDir = novelPaths.storyboardsDir(sel.novelName, sel.episode);
  const files = (await fs.readdir(storyboardsDir)).filter(
    (name) => name.startsWith("storyboard_") && name.endsWith(".jsonl"),
  );
  const candidates: CoverCandidate[] = [];

  for (const filename of files) {
    const sceneName = filename.replace(/^storyboard_/, "").replace(/\.jsonl$/, "");
    const lines = (await fs.readFile(path.join(storyboardsDir, filename), "utf-8")).split(/\r?\n/);
    for (let gi = 0; gi < lines.length; gi++) {
      if (!lines[gi].trim()) continue;
      let group: any;
      try {
        group = JSON.parse(lines[gi]);
      } catch {
        console.warn(`  [封面] 跳过无法解析的 JSONL: ${filename}:${gi + 1}`);
        continue;
      }
      const panels = Array.isArray(group.panels) ? group.panels : [];
      for (let pi = 0; pi < panels.length; pi++) {
        const panel = panels[pi];
        if (panel?.is_continuation === true) continue;
        const prefix = `g${String(gi).padStart(2, "0")}_p${String(pi).padStart(2, "0")}.png`;
        const imagePath = path.join(novelPaths.renderDir(sel.novelName, sel.episode, sceneName), prefix);
        if (!fsSync.existsSync(imagePath)) continue;
        candidates.push({
          id: `P${String(candidates.length + 1).padStart(3, "0")}`,
          imagePath,
          sceneName,
          groupIndex: gi,
          panelIndex: pi,
          text: String(group.text ?? "").slice(0, 500),
          imagePrompt: String(panel.image_prompt ?? "").slice(0, 800),
        });
      }
    }
  }

  return candidates;
}

async function buildResourceCandidates(sel: NovelSelection): Promise<CoverCandidate[]> {
  const dir = novelPaths.resourceDir(sel.novelName);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .map((name, index) => ({
      id: `R${String(index + 1).padStart(3, "0")}`,
      imagePath: path.join(dir, name),
    }));
}

async function createStoryPlan(sel: NovelSelection): Promise<{ plan: CoverPlan; candidates: CoverCandidate[] }> {
  const candidates = await buildStoryCandidates(sel);
  if (candidates.length === 0) throw new Error("没有可用于故事封面的已渲染 panel 图片");

  const chapterFile = await locateChapterFile(sel);
  const chapterLabel = chapterFile ? chapterFile.replace(/\.txt$/i, "").trim() : `第${sel.nextChapter}章`;
  const title = `${cleanNovelName(sel.novelName)} ${chapterLabel}`;
  const candidateText = candidates.map((item) => ({
    candidate_id: item.id,
    scene: item.sceneName,
    group_index: item.groupIndex,
    panel_index: item.panelIndex,
    text: item.text,
    image_prompt: item.imagePrompt,
    image_path: item.imagePath,
  }));
  const output = await runSubAgent(
    [],
    STORY_COVER_SYSTEM,
    [`指定封面标题：${title}`, "", "候选分镜：", JSON.stringify(candidateText, null, 2)].join("\n"),
    "[故事封面策划]",
    [],
  );
  const plan = parsePlan(output);
  plan.title = title;
  return { plan, candidates };
}

async function createEssayPlan(sel: NovelSelection): Promise<{ plan: CoverPlan; candidates: CoverCandidate[] }> {
  const candidates = await buildResourceCandidates(sel);
  const cleanPath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const article = await fs.readFile(cleanPath, "utf-8");
  const resourceText = candidates.length === 0
    ? "（resource 目录不存在或没有图片，必须返回 reference_id: null）"
    : JSON.stringify(candidates.map((item) => ({
        candidate_id: item.id,
        filename: path.basename(item.imagePath),
        image_path: item.imagePath,
      })), null, 2);
  const output = await runSubAgent(
    [],
    ESSAY_COVER_SYSTEM,
    [
      `项目：${cleanNovelName(sel.novelName)}`,
      "封面必须用文章主体、明确的公司/产品 logo 和一个具体动作讲清事件；背景必须是整幅颜色完全一致的浅色纯色，优先纯白或米白，禁止深色、渐变、辉光、粒子、全息、霓虹、光环、光带及抽象科技元素。主体必须采用写实商业摄影或高品质三维海报质感，通过前中景、真实透视、材质细节、遮挡关系和自然接触阴影表现纵深与立体感，严禁动漫、卡通和扁平插画。标题不含章数集数，控制在约12个汉字，具体醒目，可在顶部或中央但不能放底部。",
      "",
      "== 全文 ==",
      article.slice(0, 50000),
      article.length > 50000 ? "\n（全文过长，此处已截断）" : "",
      "",
      "== resource 图片候选 ==",
      resourceText,
    ].join("\n"),
    "[议论文封面策划]",
    candidates.length > 0 ? [readTool] : [],
    novelPaths.workspaceDir(sel.novelName),
  );
  return { plan: parsePlan(output), candidates };
}

/** 生成本集横竖封面；两张都已存在时直接跳过。 */
export async function generateEpisodeCovers(sel: NovelSelection): Promise<void> {
  const landscapePath = novelPaths.coverLandscape(sel.novelName, sel.episode);
  const portraitPath = novelPaths.coverPortrait(sel.novelName, sel.episode);
  const needLandscape = !fsSync.existsSync(landscapePath);
  const needPortrait = !fsSync.existsSync(portraitPath);
  if (!needLandscape && !needPortrait) {
    console.log("  [封面] 横竖封面均已存在，跳过");
    return;
  }

  console.log(`\n  正在策划第${sel.episode}集封面...`);
  const { plan, candidates } = sel.articleType === "essay"
    ? await createEssayPlan(sel)
    : await createStoryPlan(sel);

  const selected = plan.reference_id === null
    ? null
    : candidates.find((candidate) => candidate.id === plan.reference_id);
  if (plan.reference_id !== null && !selected) {
    throw new Error(`封面智能体返回了无效参考图 ID: ${plan.reference_id}`);
  }

  await fs.mkdir(novelPaths.coversDir(sel.novelName, sel.episode), { recursive: true });
  await fs.writeFile(novelPaths.coverPlan(sel.novelName, sel.episode), JSON.stringify({
    ...plan,
    reference_image: selected?.imagePath ?? null,
  }, null, 2), "utf-8");

  const refs = selected ? [selected.imagePath] : [];
  if (needLandscape) {
    await generateImage(plan.landscape_prompt, landscapePath, refs, "16:9");
  }
  if (needPortrait) {
    await generateImage(plan.portrait_prompt, portraitPath, refs, "9:16");
  }
  console.log(`  [封面] 已生成: ${novelPaths.coversDir(sel.novelName, sel.episode)}`);
}
