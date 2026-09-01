# `<sc-video>` 统一标签合成方案

## 状态

这是议论文流水线的目标设计，供审核使用；本文不代表已实现。

适用范围仅为议论文。故事流水线、现有故事分镜 JSONL 协议和故事渲染流程不在本次改造范围内。

## 已确认的产品决定

1. 画面预设是上游创意源：先描述画面、视频节奏和 MG 动画意图，审核后才生成标签 HTML。
2. 标签 HTML 不含时间戳。TTS 完成后产生的 `article_timeline.json` 是唯一的全文绝对时间真相。
3. HTML 使用自定义标签 `<sc-video>`，产品界面也直接显示 `<sc-video>`。
4. 全部画面内容，包括普通视频和 MG 模板，都通过同一套 Function Calling 规划和校验机制进入最终合成。
5. 最终成片是时间轴上的“拼图”：基础视频片段首尾拼接，嵌套标签形成同一时间窗内的分层合成；不再先渲染一条完整底视频再单独叠加 MG。
6. 不新增 `timed_video_plan.json` 或其他全文时间轴文件。运行日志可输出紧凑输入 scope；规划数据继续放在现有 MG 调用记录和渲染 bundle 中。

## 目标流水线

```text
清稿
  -> 画面预设（画面内容 + 视频节奏 + MG 动画意图）
  -> 人工审核
  -> 标签 HTML
  -> 全量 TTS
  -> article_timeline.json
  -> 代码编译标签树、时间窗和帧级拼图框架
  -> Function Calling 规划全部 <sc-video> 与 MG 实例
  -> 校验全部调用
  -> 参考图 / 首帧生成队列
  -> 视频片段生成队列
  -> 单次 Remotion 时间轴合成
  -> 字幕、音轨、最终封装
```

`article_timeline.json` 必须在所有 TTS group 完成后立即构建，不能再等待视频主轨完成。后续每一项视觉产物都适配这条时间轴；视觉生成的时长误差不能回写或重算音频时间轴。

## HTML 协议

### 顶层基础视频

每个正文范围必须被一个顶层 `<sc-video>` 覆盖。所有顶层 `<sc-video>` 在时间轴上无重叠、无空洞，按原文顺序组成基础视频轨道。

```html
<p>
  <sc-video group="normal" order="1">
    大模型先
    <directed-graph group="flow" mode="together" value="1">
      提出候选
      <emphasis group="scale" mode="together" value="1">token</emphasis>
    </directed-graph>，
    再由目标模型验证。
  </sc-video>
</p>
```

`<sc-video>` 的 `group` 当前为 `normal`，保留该字段是为了和其他标签共用实例协议，以及为将来的合法视频渲染样式预留空间。

`order` 的规则与现有标签一致：同一标签、同一 `group` 存在多个独立实例时，从 1 连续编号；只有一个实例时不写 `order`。

MG 标签继续保留 `group`、`order`、`mode=together|split` 和 `value`。HTML 不允许 `at`、`duration`、`zIndex`、绝对路径或模型生成的文件名。

### 嵌套语义

- 标签可嵌套，但同一实例不能嵌套自身。
- 子标签的有效窗口必须与父标签窗口求交集；父层结束后，子层不能悬空显示。
- 顶层 `<sc-video>` 是 `base` 轨道；嵌套 `<sc-video>` 是局部 `scene` 替换层；透明模板是 `overlay` 叠加层。
- 嵌套深度决定绝对层级：越内层越靠上。模板类型只在同一深度内决定稳定排序。
- 不透明 `scene` 会遮住下层，这是正常的视觉结果；透明 `overlay` 才会透出父层。

代码需要为每个实际标签节点生成一个模型不可写的结构节点，而不只使用实例键：

```ts
type CompositionNode = {
  nodeId: string;              // DOM 路径，区分同一实例的多个节点
  instanceKey: string;         // htmlTag + group + order
  parentNodeId?: string;
  depth: number;
  documentOrder: number;
  window: { startFrame: number; endFrame: number };
  role: "base" | "scene" | "overlay";
  policy: "exclusive" | "additive";
  zIndex: number;              // 只由代码计算
};
```

建议层级排序为：先 `depth`，再 `role`，最后 `documentOrder`。`zIndex` 可以按 `depth * 1000 + roleBand + documentOrder` 计算，其中同深度的 `base < scene < overlay`。这保证任何子标签均高于其祖先，避免依赖 Remotion 数组碰巧的插入顺序。

## Function Calling 协议

### 统一链路

所有标签都走同一条 Provider 驱动的链路：

```text
模板 schema
  -> Provider binding
  -> 本次 HTML 实际标签筛选工具
  -> Agent custom tool
  -> 模型调用
  -> schema + HTML + 时间轴交叉校验
  -> 合成计划
  -> 后台媒体执行
```

工具不是模型临时发明。Provider 注册函数名、参数 schema、HTML 标签映射、参数解析器和渲染载荷；Planner 只注册这篇文章实际使用的标签对应工具。

工具的 `execute()` 只做参数校验和收集，立即返回。不得在工具调用中生成参考图、提交 ComfyUI、轮询视频或等待文件落盘。

### `<sc-video>` 工具

`<sc-video>` 注册为一个 Provider binding，例如 `create_sc_video`。建议契约如下：

```ts
create_sc_video({
  group: "normal",
  order: 1 | null,
  at: 12.640,
  duration: 4.320,

  reference_image_state: "existing" | "generate" | "none",
  reference_image_path?: "characters/expert.png",
  reference_image_prompt?: "用于生成首帧的提示词",

  video_prompt: "主体、动作、镜头、节奏和画面变化"
})
```

约束如下：

- `group`、`order`、`at` 与其他模板相同：模型可见，必须从标签和 scope 原样复制，代码交叉校验。
- `duration` 和目标帧数由代码从标签对应的真实 TTS 时间窗算出。模型可见以便写出相称的镜头提示，但不能自行改变。
- `reference_image_state="existing"` 时必须提供 `reference_image_path`。路径只能从本次代码提供的可用参考图清单中原样选择，并验证其存在于允许的项目资源目录。
- `reference_image_state="generate"` 时必须提供 `reference_image_prompt`，代码先生成首帧，再进入图生视频。
- `reference_image_state="none"` 时不填上述两个字段。它表示没有创意指定参考图，不代表当前图生视频技术链路可以没有图片；第一版由代码按 `video_prompt` 自动生成技术首帧，未来接入真正的文生视频工作流后可保持同一协议。
- `video_prompt` 必填，负责实际视频的主体、行为、镜头、速度和画面变化。

`reference_image_state` 取代模糊的 `mode`。MG 的 `mode` 仍只表示 `together` 或 `split`。

### 给模型的紧凑上下文

不再把全文 HTML、全文时间轴和无关工具 schema 反复发送给模型。代码先完整验证 HTML 和全文时间轴，再按标签实例即时拼装 scope，例如：

```text
实例：<sc-video> / group=normal / order=1 / depth=0
原文与真实绝对时间：
大(12.640)模(12.710)型(12.781)先(12.847)…

子结构：
- <directed-graph group=flow value=1>提出候选 token</directed-graph>
```

对于 MG 实例，scope 至少包含当前实例的节点文字、节点的绝对时间、所在段落必要连接词和嵌套关系摘要。不得只给几个孤立节点词组，否则关系图和因果模板会丢失语义。

完整 HTML 与完整时间轴仍只在代码本地用于校验、定位和生成 scope；不必再作为模型上下文整体发送。

## 时长、帧边界与补齐

1. 以最终 FPS 将所有基础视频窗口量化为连续帧边界，保证前一个片段的结束帧等于下一个片段的开始帧。
2. 视频模型输出长于目标窗口时裁切尾部。
3. 视频模型输出短于目标窗口时冻结最后一帧补齐。
4. 极短窗口或无动作需求时，直接由首帧生成静态视频，不调用视频模型。
5. LTX 的帧数栅格误差只在视频侧消化；不得为了画面长度重新拉伸 TTS 或改变 `article_timeline.json`。

这样全文时间轴是拼图框架，所有视觉片段必须填满它，最终时长总是与配音一致。

## 最终合成

最终 Remotion composition 应直接接收：

- 每个顶层 `<sc-video>` 的基础片段；
- 嵌套 `<sc-video>` 的局部替换片段；
- 所有 MG `scene` 和透明 `overlay` 图层；
- TTS 对齐音轨和字幕时间轴。

它以显式 `startFrame`、`durationFrames` 和 `zIndex` 合成一次输出。透明图层必须保留在同一 alpha-capable composition 中，不能先单独编码为 H.264 再二次叠加。

目标设计不再把 `epXX_raw.mp4` 作为视觉底片概念。过渡期间可保留旧路径和产物名以兼容已有最终封装代码，但它的内容应逐步改为“基础视频拼图轨道”，最终由统一 composition 取代。

## 现有代码基线

目前已具备、可复用的能力：

- HTML 解析已支持不同实例的嵌套，并保存 `depth`、`parentInstance` 和正文偏移：`runner/mg/html.ts`。
- 现有 Provider 已把模板函数、schema、HTML 标签、group 和参数 resolver 绑定为单一注册源：`@story-claw/mg-templates/provider`。
- Planner 已按实际 HTML 标签筛选 Function Calling 工具，且工具执行仅校验并收集调用：`runner/mg/planner.ts`。
- Renderer 已在一次 Remotion composition 中处理透明 MG 图层：`runner/mg/renderer.ts` 与模板包 `runtime/render-entry.tsx`。
- 视频生成已有图生视频、并发背压、重试和静帧兜底：`runner/render.ts`。

需要替换或扩展的部分：

- 当前 HTML 白名单只包含 MG 标签；需要将 `<sc-video>` 加入统一标签注册和校验。
- 当前全文时间轴在视频母版之后产生；需拆出全量 TTS 阶段并提前写入既有 `article_timeline.json`。
- 当前渲染 runtime 固定使用完整 raw master 作为底层；需改成基础视频片段与所有标签层的统一 composition。
- 当前 scene 重叠规则是“更深者胜出”；需改为显式的结构节点、裁剪和 `zIndex` 合成规则。
- 当前 Function Calling 会发送全文 HTML 与全文时间轴；需改为本地解析后的紧凑实例 scope。

## 实施顺序

1. 扩展统一标签注册、HTML 校验和标签树，加入 `<sc-video>`，并为嵌套、重复原文、跨段和非法重叠写纯函数测试。
2. 拆分 TTS 与视觉渲染：先完成全部 TTS，提前建立 `article_timeline.json`，编译连续帧窗口。
3. 新增 `<sc-video>` Provider binding 与 `create_sc_video` schema；实现参考图三态校验和安全路径白名单。
4. 生成紧凑 scope，保留全文级“每个实例恰好一次”校验；所有调用成功后再启动媒体队列。
5. 实现视频片段时长归一化、冻结末帧补齐和续跑复用。
6. 将 Remotion runtime 改为显式基础片段、替换片段和透明图层的单次合成，按结构层级输出。
7. 以短、中、长三篇议论文做集成验证：无 MG、单层 MG、透明嵌套、多层 scene/overlay、参考图三态、视频生成失败续跑。

## 验收条件

- 顶层 `<sc-video>` 精确覆盖全文 TTS 时间轴，没有帧空洞或重叠。
- 每一实例恰好得到一次合法 Function Call，错误实例不会启动媒体任务。
- 模型只能引用代码列出的已有图片路径；任何越界路径被拒绝。
- 视频长度与目标帧窗口完全一致；短片段冻结末帧补齐。
- 内层标签始终高于祖先，透明模板能透出下层，不透明模板按设计遮盖。
- 最终总时长、字幕和音轨均与 `article_timeline.json` 一致。
- 不新增全文时间轴或多余中间计划文件。
