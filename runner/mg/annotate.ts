import fs from "node:fs/promises";
import {formatMgTemplateUsage, MG_DEFAULT_STYLE_HINT} from "@story-claw/mg-templates";
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

使用门槛：
- 先判断是否存在能明显提升理解的动画结构；普通事实、能力描述、并列案例或孤立数字不加 MG
- 没有合适模板时保留原文，不要为了覆盖率强行标注

模板用法（由模板项目维护）：
${formatMgTemplateUsage()}

每个标签使用以下属性：
- group：渲染样式。首次生成固定使用该结构的默认样式：${MG_DEFAULT_STYLE_HINT}
- order：同一篇文章中同一种标签存在两个或更多独立动画实例时才填写。按各实例第一次出现的正文顺序从 1 连续编号；同一实例的全部节点使用相同 order。该标签只有一个实例时不得填写 order
- value：同一动画实例内部按正文顺序从 1 连续编号
- mode：together 表示连续显示为一段动画；split 表示分别显示，中间恢复原画

标注规则：
- 一个动画实例由“标签名称 + order”确定；该标签只有一个实例时 order 隐含为 1
- 同一实例必须使用相同 group 样式和 mode；不同实例允许使用相同 group 样式
- 标签只包裹实际对应动画节点或元素的文字
- 可以嵌套，但嵌套标签必须属于不同动画实例
- <mg-title> 和 <emphasis> 每个动画实例只能出现一次
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
      const {html, instanceCount, tagCount} = prepareMgAnnotationHtml(response, article);
      await fs.writeFile(outputPath, html, "utf-8");
      console.log(`[MG标注] ${instanceCount} 个动画实例 / ${tagCount} 个标签 → ${outputPath}`);
      return outputPath;
    } catch (error) {
      lastError = error;
      feedback = error instanceof Error ? error.message : String(error);
      console.warn(`[MG标注] 第 ${attempt}/3 次未通过: ${feedback}`);
    }
  }
  throw lastError ?? new Error("MG 标注 HTML 生成失败");
}
