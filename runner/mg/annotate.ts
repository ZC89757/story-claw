import fs from "node:fs/promises";
import {runSubAgent} from "../../agent.js";
import {novelPaths} from "../../utils/paths.js";
import type {NovelSelection} from "../../ui/select.js";
import {prepareMgAnnotationHtml} from "./html.js";

const MG_ANNOTATION_SYSTEM = `你负责为议论文原文添加 MG 动画语义标签。

输出要求：
- 输出一份从 <!DOCTYPE html> 到 </html> 的完整 HTML，只包含一个 <article>
- 原文每个自然段放入一个 <p>，段落文字不换行
- 去掉标签后，正文必须与输入原文逐字一致
- 只输出 HTML，不要解释、Markdown、CSS 或 JavaScript

可用标签：
- <progress-timeline>：时间、阶段、里程碑或流程
- <timed-table>：表格、矩阵或多项指标
- <directed-graph>：因果链、商业飞轮或依赖关系
- <side-by-side-comparison>：普通左右对照
- <weighted-comparison>：原文存在明确轻重或权重的对照
- <decomposition>：整体拆成多个部分
- <xy-chart>：单组数值趋势
- <multi-series-chart>：多组数值趋势
- <containment>：包含或层级关系
- <collage-network>：公司、产品、人物或机构关系
- <mg-title>：章节或内容转场标题
- <emphasis>：需要短暂强调的文字，最多 16 个汉字

每个标签只使用三个属性：
- group：同一动画使用相同标识，只能包含英文字母、数字、下划线和连字符
- value：同一 group 按正文顺序从 1 连续编号
- mode：together 表示连续显示为一段动画；split 表示分别显示，中间恢复原画

标注规则：
- 一个 group 对应一段动画；同一 group 必须使用相同标签和 mode
- 标签只包裹实际对应动画节点或元素的文字
- 可以嵌套，但嵌套标签必须使用不同 group
- <mg-title> 和 <emphasis> 每个 group 只能出现一次
- 不要让无关的全屏动画重叠；只标注动态图形明显优于普通画面的内容`;

export async function annotateEssayMg(sel: NovelSelection): Promise<string> {
  const articlePath = novelPaths.cleanedText(sel.novelName, sel.episode);
  const outputPath = novelPaths.mgAnnotation(sel.novelName, sel.episode);
  const article = await fs.readFile(articlePath, "utf-8");
  await fs.mkdir(novelPaths.episodeDir(sel.novelName, sel.episode), {recursive: true});

  let feedback = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await runSubAgent(
      [],
      MG_ANNOTATION_SYSTEM,
      [
        feedback ? `校验错误：\n${feedback}\n请重新输出完整 HTML。` : "",
        "== 议论文原文 ==",
        article,
      ].filter(Boolean).join("\n\n"),
      `[MG标注 ${attempt}/3]`,
      [],
    );
    try {
      const {html, groupCount, tagCount} = prepareMgAnnotationHtml(response, article);
      await fs.writeFile(outputPath, html, "utf-8");
      console.log(`[MG标注] ${groupCount} 个 group / ${tagCount} 个标签 → ${outputPath}`);
      return outputPath;
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`[MG标注] 第 ${attempt}/3 次未通过: ${feedback}`);
    }
  }
  throw lastError ?? new Error("MG 标注 HTML 生成失败");
}
