import fs from "node:fs/promises";
import {createHash} from "node:crypto";
import {getMgTemplateProvider} from "@story-claw/mg-templates/provider";
import {runSubAgent} from "../../agent.js";
import {novelPaths} from "../../utils/paths.js";
import type {NovelSelection} from "../../ui/select.js";
import {prepareMgAnnotationHtml} from "./html.js";

const mgProvider = getMgTemplateProvider();

const MG_ANNOTATION_SYSTEM = `你负责为议论文原文添加视觉动画语义标签。

输出要求：
- 输出一份从 <!DOCTYPE html> 到 </html> 的完整 HTML，只包含一个 <article>
- 原文每个自然段放入一个 <p>，段落文字不换行
- 去掉标签后，正文必须与输入原文逐字一致
- 只输出 HTML，不要解释、Markdown、CSS 或 JavaScript

使用门槛：
- 先判断是否存在能明显提升理解的动画结构；普通事实、能力描述、并列案例或孤立数字不加 MG
- 没有合适模板时保留原文，不要为了覆盖率强行标注

${mgProvider.getAnnotationInstructions()}

上游画面预设约束：
- 你会同时收到“议论文画面预设”。每行包含画面内容、动画形式、动画节奏和视觉细节
- 把该预设当作本次 HTML 标注的上游视觉契约：需要 AI 生成普通短视频时使用 <sc-video group="normal">；需要较长连续视觉叙事时使用 <sc-longtake group="relay">；结构化 MG 使用对应模板标签
- <sc-video> 与其他标签平级，只包裹实际需要生成视频的原文，不要求覆盖全文
- <sc-video> 只允许 group="normal" 和可选 order，不使用 mode 或 value
- <sc-longtake> 与 <sc-video> 平级，只包裹一个连续视觉实例；只允许 group="relay" 和可选 order，不使用 mode 或 value
- 当一段话需要保持同一镜头轴线、主体和运动连续，但预计超过单次 AI 视频的稳定时长时，优先使用 <sc-longtake>；普通短片仍使用 <sc-video>
- 保持预设的原文顺序和 group 边界，不得把不相邻 group 合并成同一个动画实例；视觉意图只用于决策，绝不能写入 HTML 正文
- 预设只描述视觉意图；at 仍属于后续 Function Calling 阶段，禁止在本 HTML 中输出 at

标注规则：
- 标签只包裹实际对应动画节点、元素或视频片段的文字
- 可以嵌套，但嵌套标签必须属于不同动画实例
- <mg-title> 和 <emphasis> 每个动画实例只能出现一次
- 不要让无关的全屏动画重叠；只标注动态图形明显优于普通画面的内容
- mode="split" 时每个节点独立标注并使用 value；mode="together" 时只使用一个外层标签包裹完整范围，并用 values='["词语1","词语2"]' 指定节点词。values 必须是 JSON 字符串数组且逐字出现在正文中`;

export interface EssayMgAnnotationResult {
  outputPath: string;
  presetHash: string;
}

export async function annotateEssayMg(sel: NovelSelection): Promise<EssayMgAnnotationResult> {
  const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const presetPath = novelPaths.visualPreset(sel.novelName, sel.episode);
  const outputPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
  const [article, visualPreset] = await Promise.all([
    fs.readFile(articlePath, "utf-8"),
    fs.readFile(presetPath, "utf-8"),
  ]);
  if (!visualPreset.trim()) throw new Error(`议论文画面预设为空: ${presetPath}`);
  const presetHash = createHash("sha256").update(visualPreset).digest("hex");
  await fs.mkdir(novelPaths.episodeDir(sel.novelName, sel.episode), {recursive: true});

  let feedback = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await runSubAgent(
      [],
      MG_ANNOTATION_SYSTEM,
      [
        feedback ? `校验错误：\n${feedback}\n请重新输出完整 HTML。` : "",
        "== 议论文画面预设（上游视觉契约）==",
        visualPreset,
        "== 议论文原文 ==",
        article,
      ].filter(Boolean).join("\n\n"),
      `[MG标注 ${attempt}/3]`,
      [],
    );
    try {
      const {html, instanceCount, tagCount} = prepareMgAnnotationHtml(response, article);
      await fs.writeFile(outputPath, html, "utf-8");
      console.log(`[MG标注] ${instanceCount} 个动画实例 / ${tagCount} 个标签 → ${outputPath}`);
      return {outputPath, presetHash};
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`[MG标注] 第 ${attempt}/3 次未通过: ${feedback}`);
    }
  }
  throw lastError ?? new Error("MG 标注 HTML 生成失败");
}
