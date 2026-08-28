---
name: story-claw-mg-template
description: "在 Story Claw 的模板包中新增或修改 MG 模板，并生成真实 Remotion 预览；适用于模板、样式、catalog、Function Calling 对接和预览维护。"
---

# Story Claw MG 模板

这个公开 Skill 用于维护 Story Claw 的 MG（Motion Graphics）模板，并保持模板预览与正式渲染一致。模板包负责 Remotion 组件、运行时导出、样式目录和预览视频；Story Claw 负责标注、时间轴规划和调用模板。

## 工作边界

- 优先修改独立模板包中的组件、类型、catalog 和预览入口。
- 只有新增模板类型或改变运行时契约时，才同步修改 Story Claw 的 registry、Function Calling schema 或 renderer。
- 保持现有函数名称、spec 字段语义和 `renderMode` 兼容；不要把预览专用逻辑写进正式渲染组件。
- 每个模板的使用条件集中维护在 `src/template-usage.ts`，每项只包含 `template` 和 `useWhen`。
- 预览必须复用正式 Remotion 组件，不用 CSS 假动画替代真实渲染。

## 工作流程

1. 判断是已有模板样式调整，还是新增模板类型。
2. 修改模板组件、schema、catalog 和 `src/template-usage.ts`；新增类型时补齐宿主项目的契约映射。
3. 在 `runtime/preview-entry.tsx` 为 catalog 的 `previewKind` 提供短小、可代表核心运动的 spec，并通过等比画布展示完整的 1920×1080 内容。
4. 在模板包根目录运行：

   ```bash
   npm run typecheck
   npm test
   npm run render:previews -- --force
   npm run check:previews
   ```

5. 用 `ffprobe` 或等效工具确认每个预览存在视频流、尺寸正确且时长大于零；抽查起始、中段和结尾画面。

## 数据与时间轴约定

- HTML 标注阶段只填写 `group`、`mode`、`value` 等标注属性，不填写绝对时间 `at`。
- Function Calling 阶段为根和动态元素填写整集绝对 `at`；resolver 再换算为模板内部时间。
- 同一模板有多个实例时，`order` 从 1 连续编号；只有一个实例时省略 `order`。
- 长时间轴使用模板自身的 viewport/follow 逻辑，不要为了缩略图强行压缩或裁掉正式画布。

## 公开提交要求

- 只提交通用模板代码、示例、catalog、预览和本 Skill 所需文档。
- 不提交绝对本机路径、用户名、API key、私有配置、运行时状态、缓存、日志或机器专属目录。
- 文档和示例使用相对路径、环境变量或 `<project-root>` 占位符。
- 生成的临时抽帧、调试视频和失败产物不要放进公开预览目录。
