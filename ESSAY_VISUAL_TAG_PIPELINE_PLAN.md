# 议论文视觉标签视频流水线

## 适用范围

本文记录当前议论文视觉标签流水线的实现规则。故事流水线保持原有流程。

## 流水线顺序

```text
清稿
  -> 画面预设 Agent
  -> 可选人工审核画面预设
  -> 视觉标签 HTML Agent
  -> 全量 TTS 与字幕时间
  -> article_timeline.json
  -> 解析标签实例、嵌套结构和时间窗口
  -> 按顶层 scope 有限并发启动 Function Calling Agent
  -> 生成并归一化每个实例的视频片段
  -> Remotion 按时间轴和层级合成视觉母版
  -> FFmpeg 烧字幕并混合旁白、模板音效
  -> 议论文后处理与最终成片
```

议论文不再执行资源建档、剧本分场、分镜制作、原画渲染和原画母版阶段。

## 画面预设

- 输入为 `原文_clean.txt`。
- 每个处理单元输出四项：画面内容、动画形式、动画节奏、视觉细节。
- 画面预设不包含 HTML 标签、`group`、`order`、`value`、`mode`、`at`、参考图路径或视频路径。
- 开启人工审核时，流水线在画面预设完成后暂停。
- 人工确认画面预设后，续跑才生成视觉标签 HTML。
- 未开启人工审核时，画面预设完成后直接生成视觉标签 HTML。

## 视觉标签 HTML

- HTML Agent 同时读取清稿和画面预设。
- HTML 去除标签后的正文必须与清稿逐字一致。
- HTML 只添加 Provider 已注册的视觉标签及其合法结构属性。
- HTML 中禁止 `at`、时长、帧范围、参考图路径、媒体路径和任务状态。
- 标签可以嵌套，但同一个动画实例不能嵌套自身。
- 没有适合动画的正文保持无标签状态。

## `<sc-video>`

`<sc-video>` 是与其他 MG 标签平级的普通视觉标签，用于生成 AI 视频片段。

```html
<sc-video group="normal">大模型正在改变软件开发方式。</sc-video>
```

- 当前只支持 `group="normal"`。
- 只包裹需要生成 AI 视频的正文，不要求覆盖全文。
- 不使用 `mode` 和 `value`。
- 同标签同 `group` 只有一个实例时省略 `order`。
- 同标签同 `group` 有多个独立实例时，按首次出现顺序使用连续 `order=1,2,3...`。
- 一个 `<sc-video>` 实例只能对应一个 DOM 标签。
- `<sc-video>` Function Calling 参数不包含 `at`，真实时间由宿主代码绑定。

## MG 实例

实例身份为：

```text
htmlTag + group + 可选 order
```

- 普通 MG 实例可由同一实例键的多个 `value` 节点组成。
- 同一实例的 `value` 从 1 按正文顺序连续编号。
- 同一实例只执行一次 Function Calling。
- 普通 MG Function Calling 使用 scope 内真实字级绝对时间填写根 `at` 和元素 `at`。
- `<sc-video>` 的根时间和窗口由宿主按标签正文直接计算。

## Agent 调用时机

### 画面预设 Agent

- 清稿完成后调用。
- 输入为议论文清稿。
- 输出为 `画面预设.txt`。

### 视觉标签 HTML Agent

- 画面预设完成且无需审核，或画面预设人工确认后调用。
- 输入为清稿和当前画面预设。
- 输出为 `mg_annotation.html`。

### Function Calling Agent

- `mg_annotation.html` 已生成、全量 TTS 已完成、`article_timeline.json` 已写入后调用。
- Agent 由代码启动，按最外层标签 scope 建立会话。
- 顶层实例及其全部嵌套实例交给同一个 Agent。
- 嵌套实例不单独启动 Agent。
- 多个顶层 scope 按固定并发上限分批运行。
- 一个 Agent 为 scope 内每个逻辑实例各调用一次对应工具。
- Agent 会话只收集并校验 Function Calls，不等待视频生成。
- 全部 scope Agent 完成后，当前流水线进程按有限并发执行媒体任务，并等待全部任务完成。

## Agent 输入边界

代码读取完整 HTML 和 `article_timeline.json`，只为当前 scope 拼装输入。

每个 Function Calling Agent 接收：

- 顶层 scope 的实例信息；
- scope 内标签包裹的精确正文；
- 这些正文对应的真实字级绝对时间，格式为 `字(秒)`；
- scope 内的嵌套结构、`group`、可选 `order`、`value` 和深度；
- 当前 scope 所需的 Function Calling 工具；
- scope 含 `<sc-video>` 时的可用参考图白名单。

每个 Function Calling Agent不接收：

- 全文 HTML；
- 全文字级时间轴；
- 其他 scope 的正文和时间；
- 无关模板工具；
- 其他 Agent 的会话内容。

示例：

```text
实例：<directed-graph> / group=flow / order=null / depth=0

原文与真实绝对时间：
提(12.640)出(12.710)候(12.781)选(12.847)目(13.200)标(13.280)模(13.350)型(13.430)验(13.510)证(13.600)

子结构：
- <directed-graph> group=flow order=null depth=0：value=1「提出候选」；value=2「目标模型验证」
```

## Function Calling 结果

- 每个逻辑实例最终对应一个可读取的视频文件。
- Function Calling 向 Agent 返回接受确认。
- `taskId` 是写入 `function_calls.json` 的任务记录标识，不是后台轮询句柄。
- Agent 会话结束后，当前流水线进程继续执行并等待媒体任务。
- `<sc-video>` 任务状态为 `queued -> preparing_reference -> generating_video -> normalizing -> completed`。
- MG 模板任务状态为 `queued -> rendering_template -> completed`。
- 两类任务失败均记录为 `failed`，单个媒体任务最多尝试三次。
- `function_calls.json` 保存参数、状态、重试次数、时间窗口、可选 `split` 活动窗口和最终 `videoPath`。

## `<sc-video>` Function Calling

已注册函数：

```ts
create_sc_video({
  group: "normal",
  order: number | null,
  reference_image_state: "existing" | "generate" | "none",
  reference_image_path?: string,
  reference_image_prompt?: string,
  video_prompt: string,
});
```

参考图状态：

- `existing`：从当前 scope 的参考图白名单选择已有文件。
- `generate`：先按 `reference_image_prompt` 生成参考图，再生成视频。
- `none`：不选择已有参考图，也不单独提供参考图提示词；代码使用 `video_prompt` 生成技术首帧，再执行图生视频。

执行顺序：

```text
校验 Function Call
  -> 宿主绑定标签正文的真实时间窗口
  -> 选择已有参考图或生成参考图/技术首帧
  -> 生成视频
  -> 裁切长视频或冻结末帧补齐短视频
  -> 校验目标帧数
  -> 写入最终视频文件
```

视频模型的长任务不会占用 Agent 会话，但当前流水线进程会等待任务完成。

## MG 模板视频

- 每个 MG 实例先由 Function Calling 生成模板参数。
- 宿主按标签时间窗口把模板渲染为独立视频片段。
- `scene` 模板片段输出 H.264 MP4。
- `overlay` 模板片段输出带 alpha 的 ProRes 4444 MOV。
- `mode="split"` 的模板片段在单个视频内按节点运动窗口显隐；窗口之间保持透明，并输出 ProRes 4444 MOV。
- 模板固定音效保留在片段中。
- 最终合成直接播放已生成片段，不重复执行模板渲染。

## 时间窗口

- `article_timeline.json` 是唯一的全文字级绝对时间轴。
- 标签正文的首字和末字确定实例的基础时间窗口。
- 普通 MG 根据模板显示规则保留最小可见时长和尾部停留时间。
- `<sc-video>` 使用其正文的实际时间窗口。
- 子实例窗口与父实例窗口取交集。
- 子实例不能超出父实例显示范围。
- 视频长于窗口时裁切。
- 视频短于窗口时冻结最后一帧补齐。
- 视频帧数栅格误差只在视频侧处理，不修改 TTS 和全文时间轴。

## 嵌套与图层

- 每个标签实例对应一个合成节点。
- 根实例和嵌套实例都生成各自的视频片段与节点。
- 子节点通过 `parentNodeId` 指向直接父实例。
- 嵌套越深，`zIndex` 越高。
- 同一深度中，`overlay` 高于 `scene`。
- 同层按正文出现顺序保持稳定顺序。

最小持久化节点：

```ts
type CompositionNode = {
  nodeId: string;
  parentNodeId?: string;
  videoPath: string;
  startFrame: number;
  endFrame: number;
  zIndex: number;
};
```

`CompositionNode` 写入现有 `mg_plan.json` 和 `render_bundle.json`。运行时所需的模板信息不增加到最小持久化节点。

- 最终合成前严格校验 `mg_plan.json` 与 `render_bundle.json` 的版本、画布、FPS、总帧数和全部六字段节点一致。
- 最终合成只在内存中按 `functionCalls` 为节点补充透明层角色，不写回持久化 JSON。

## 合成职责

- Remotion 按 `startFrame`、`endFrame` 和 `zIndex` 合成全部视觉视频节点。
- 没有视觉标签时，Remotion 输出与整集时长一致的黑底视频。
- Remotion 视觉母版保留模板片段中的音效轨。
- FFmpeg 烧入全局字幕，并把对齐旁白与模板音效混合。
- 最终封装使用 `-shortest` 控制音视频边界。

## 复用与续跑

- 每个媒体任务使用 `taskSignature` 标识完整输入状态。
- 签名覆盖缓存版本、scope、父实例、深度、精确正文与时间、Function Call 参数、模板运行参数、帧窗口、`split` 活动窗口、分辨率和 FPS。
- 已有参考图使用文件内容 SHA-256 进入签名，同一路径替换图片会使旧片段失效。
- 视频、参考图、中间视频和 `taskId` 均绑定任务签名。
- 续跑先静态审计当前 HTML、时间轴、音频时长、参考图内容、Function Call、片段帧数、`mg_plan.json` 和 `render_bundle.json`。
- 静态审计全部通过时跳过视觉规划和合成；任一项失效时进入 `planEssayMg()`。
- 进入 `planEssayMg()` 后，只有顶层 scope 内全部旧记录的签名均匹配，才跳过该 scope Agent。
- 已完成片段必须文件存在且帧数正确才可复用。
- 未完成或无效任务由当前进程重新执行。

## 文件约束

- 继续使用 `article_timeline.json`，不新增其他全文时间轴。
- 继续使用 `mg/function_calls.json`、`mg/mg_plan.json` 和 `mg/render_bundle.json`。
- 视频片段写入现有 `mg/clips/`。
- 不新增 `timed_video_plan.json`。
- 不创建或使用 `mg/specs/`。
- 运行日志可以输出 scope、任务状态和文件路径。
- 所有项目产物路径通过 `utils/paths.ts` 构造。

## 验收清单

- 画面预设先于视觉标签 HTML，人工审核只发生在画面预设阶段。
- `<sc-video>` 是可选普通标签，只支持 `group="normal"`，不覆盖全文。
- Function Calling Agent 按顶层 scope 启动，嵌套实例由同一 Agent 处理。
- Agent 只接收当前 scope 的标签正文和真实字级绝对时间。
- 每个逻辑实例恰好一次 Function Calling，最终得到一个视频文件。
- `<sc-video>` 公开 Function Calling 参数不含 `at`。
- 参考图在视频生成前完成选择或生成。
- 子实例窗口受父实例窗口限制，嵌套越深图层越高。
- Remotion 负责视觉节点合成，FFmpeg 负责字幕和音轨。
- 已完成片段按完整签名和帧数校验复用。
- 不生成额外全文时间轴、`timed_video_plan.json` 或 `mg/specs/`。
