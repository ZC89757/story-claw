# 断线后从 GPU 服务器回收已生成视频

## 什么时候用

跑 `render` 阶段时本机 SSH/网络断了（日志停在"轮询中"或"第 N 次失败 ECONNRESET"），
但任务已经提交到 GPU 服务器。服务器上的 `pipeline_wrapper.py` 是**独立后台线程**，
不会因为本机断线而停——它会继续把队列跑完、去字幕、写出成品。

结果：视频在服务器上生成好了，本机却没机会调 `/view` 下载，本地 `render_<场景>/`
里只有 `gXX_pYY.png` 没有 `gXX_pYY.mp4`。

这份文档就是把服务器上**已经生成好但没下载**的视频找回来、精确配对回每个 panel、
落到本地正确位置的固定套路。**别再瞎试，照这个走。**

## 关键认知（先读，省得走弯路）

1. **日志里没有 prompt_id ↔ panel 的可靠配对**。render.ts 高并发提交，
   "提交 gXX_pYY.mp4" 和 "prompt_id=xxx 轮询中" 是交错乱序的，FIFO 配对会错。
   这次就是栽在这上面，**别再用日志行序硬配**。
2. **服务器产物文件名是 `wrap_<promptid前8位>_desub*.mp4`**，prompt_id 前缀无法反查 panel。
3. **能精确配对的原因**：i2v 工作流首帧 ≈ 输入参考图（`gXX_pYY.png` 本身），
   用三哈希( dHash + aHash + pHash ) + 匈牙利全局最优配对，把每个服务器成品的
   i2v 首帧和本地 panel 图一一对应。109/109 全中，margin 健康。
4. **去字幕(desub)工作流会重写整个视频含首帧**，所以配对必须抽 **i2v 首帧**
   (`wrap_*_i2v*.mp4` 第 1 帧)，**不是** desub 视频的首帧。下载时再下 desub 成品。
5. **continuation panel 不在服务器产物里**。`is_continuation=true` 的 panel 没有
   独立 png、不走 i2v 提交，靠提取前驱视频尾帧生成——这些只能重跑 render 补，
   不在"回收已生成视频"范围内。

## 环境

- 服务器：`root@117.50.171.210 -p 23`，密码见 `download_videos.py` 顶部（host key
  见同文件）。GPU 服务器上 `pipeline_wrapper.py`(8191) + ComfyUI(8188)。
- 本地：Windows + Git Bash，用 PuTTY 的 `plink`/`pscp`（`D:\PuTTY\`）。
  Git Bash 会把 `/root/...` 当 Windows 路径，**SSH 命令前加 `MSYS_NO_PATHCONV=1`**。
- 本地需要 `Pillow`、`numpy`、`scipy`：`python -m pip install Pillow scipy`。
- 服务器 ffmpeg：`/usr/local/ffmpeg/bin/ffmpeg`；Python：`/root/miniconda3/bin/python`。

## 固定四步

脚本都在 `scripts/recover_video/`。下面 `<小说>` 指 workspace 下的小说目录名，
`<epXX>` 指集目录，`<dl>` 指本地一个临时工作目录（如 `_ep02_dl`）。

### 0. 先看一眼服务器，确认这集真的有成品（可选但建议）

```bash
MSYS_NO_PATHCONV=1 /d/PuTTY/plink -P 23 -pw <密码> \
  -hostkey "SHA256:1tPTgGLrB6p01gUrrvKXixQN60H2p8K7X3VmFygdCxo" -batch \
  root@117.50.171.210 \
  "find /root/ComfyUI/output/pipeline/ -name 'wrap_*_desub*.mp4' \
     -newermt '2026-07-19 01:05:00' -printf '%TH:%TM %f\n' | sort | head"
```

时间窗起止按 render.log 里本集的提交/断线时间定。有大量 `02:xx–03:xx` 的文件
就说明服务器断线后接着跑完了，可以回收。

### 1. 本地：从 render.log 提取本集 prompt_id 列表

```bash
cd "<小说>/<epXX>"
grep -oE 'prompt_id=[0-9a-f-]{36}' render.log | sed 's/prompt_id=//' | sort -u > /tmp/pids.txt
wc -l /tmp/pids.txt   # 应≈本集 panel 数（含重试，正常 panel 的会多）
```

上传到服务器：
```bash
MSYS_NO_PATHCONV=1 /d/PuTTY/plink -P 23 -pw <密码> -hostkey "..." -batch \
  root@117.50.171.210 "mkdir -p /root/ep_dl"
MSYS_NO_PATHCONV=1 /d/PuTTY/pscp -P 23 -pw <密码> -hostkey "..." \
  /tmp/pids.txt root@117.50.171.210:/root/ep_dl/pids.txt
```

> 如果 prompt_id 列表不全或 `job_history.jsonl` 已轮转，改用
> `scan_window.py`（按时间窗直接扫 desub 成品，不依赖 job_history）：
> ```bash
> MSYS_NO_PATHCONV=1 /d/PuTTY/plink ... root@117.50.171.210 \
>   "/root/miniconda3/bin/python /root/ep_dl/scan_window.py '2026-07-19 01:05:00' '2026-07-19 04:00:00'"
> ```
> 跳过第 2 步的 prompt_id 版本，直接到第 3 步下载 manifest + 首帧。

### 2. 服务器：抽 i2v 首帧 + 生成 manifest

```bash
MSYS_NO_PATHCONV=1 /d/PuTTY/pscp -P 23 -pw <密码> -hostkey "..." \
  scripts/recover_video/extract_frames.py root@117.50.171.210:/root/ep_dl/extract.py
MSYS_NO_PATHCONV=1 /d/PuTTY/plink -P 23 -pw <密码> -hostkey "..." -batch \
  root@117.50.171.210 "/root/miniconda3/bin/python /root/ep_dl/extract.py"
```

输出：`MANIFEST <N> MISSING <m> [...]`。N 应等于本集**普通 panel** 数
（continuation 不算）。MISSING=0 即可。

`extract.py` 干的事：读 `pids.txt` → 查 `job_history.jsonl` 取 success 的 →
找 `wrap_<p8>_desub*.mp4`（下载用，去掉 `-audio` 轨）+ `wrap_<p8>_i2v*.mp4`
（配对用）→ ffmpeg 抽 i2v 第 1 帧到 `frames_i2v/<p8>.png` → 写 `manifest.json`。

### 3. 本地：下载 manifest + i2v 首帧，跑配对

```bash
mkdir -p "<dl>/frames"
MSYS_NO_PATHCONV=1 /d/PuTTY/pscp -P 23 -pw <密码> -hostkey "..." \
  root@117.50.171.210:/root/ep_dl/manifest.json "<dl>/manifest.json"
MSYS_NO_PATHCONV=1 /d/PuTTY/pscp -P 23 -pw <密码> -hostkey "..." \
  root@117.50.171.210:/root/ep_dl/frames_i2v/*.png "<dl>/frames/"

python scripts/recover_video/match_and_map.py "<小说>/<epXX>" "<dl>"
```

看输出：
- `locals <L> remotes <R>`：应相等（L 只数 `g\d+_p\d+` 标准 panel，自动排除 `*_lastframe`）。
- `cost: min/median/p90/max`：三哈希总和(0–192)。本次 median 33、max 46，很干净。
- `weak <n>`：cost>60 或 margin<5 的可疑条目。本次只有 1 条（margin_col=4 但 cost 41，可用）。
  **weak 条目务必人工抽查**——把该 panel 的本地 png 和配到的 i2v 首帧放一起看一眼，
  确认是同一画面再下载。配错只会让该 panel 视频错位，不会崩。

产物：`<dl>/mapping_final.json`，每条含 `{scene, panel, prompt_id, desub, cost, ...margin}`。

### 4. 本地：按 mapping 下载 desub 成品到正确位置

先通过环境变量配置连接信息，避免把服务器密码写进仓库：

```powershell
$env:STORY_CLAW_RECOVERY_REMOTE = "root@服务器地址"
$env:STORY_CLAW_RECOVERY_PORT = "22"
$env:STORY_CLAW_RECOVERY_PASSWORD = "服务器密码"
$env:STORY_CLAW_RECOVERY_HOSTKEY = "SHA256:服务器HostKey"
$env:STORY_CLAW_PSCP = "D:\PuTTY\pscp.exe" # 可选
```

然后运行：

```bash
python scripts/recover_video/download_videos.py "<小说>/<epXX>" "<dl>"
```

每个成品落到 `render_<场景>/gXX_pYY.mp4`，已存在且 >1KB 的跳过。看到
`DONE ok=109 fail=0` 就成。

## 验收

```bash
cd "<小说>/<epXX>"
python -c "
import os,glob
png=set(); mp4=set()
for d in os.listdir('.'):
    if not d.startswith('render_'): continue
    for x in glob.glob(d+'/g[0-9]_p[0-9].png'): png.add(x.split('/')[-1][:-4])
    for x in glob.glob(d+'/g[0-9]_p[0-9].mp4'): mp4.add(x.split('/')[-1][:-4])
print('png',len(png),'mp4',len(mp4),'缺',sorted(png-mp4)[:10])
"
```

`缺` 应为空（continuation 的 `*_lastframe` 不在 `g[0-9]_p[0-9]` 正则里，不影响）。
剩下的 `is_continuation` panel 靠重跑 render 补（见下）。

## 收尾

回收完后**不要**手动改 `改编进度.json`。直接重跑 `/solo`：已存在的 `gXX_pYY.mp4`
会被跳过，只补 continuation + 后续拼接（group 视频、集合并）。进度自然推进到 `render=done`。

## 常见坑

- **别用日志行序配对**：高并发提交，prompt_id 和 panel 名交错，FIFO 必错。
- **配对抽 i2v 首帧，不是 desub 首帧**：desub 工作流重写首帧，内容对不上。
- **本地 png 若已 >109**（中途有人重跑生成了 `_lastframe`）：match 脚本已用
  `^g\d+_p\d+$` 正则过滤，不受影响。
- **Git Bash 路径转换**：所有 `plink`/`pscp` 命令前加 `MSYS_NO_PATHCONV=1`，
  否则 `/root/miniconda3/bin/python` 被改成 `D:/Git/root/...`。
- **host key 缺失**：plink `-batch` 模式遇到未缓存 host key 会直接失败，必须带
  `-hostkey "SHA256:..."` 参数，值见 `download_videos.py` 顶部 `HK`。
- **下载的是 desub 纯视频轨**：去掉了 `-audio`（TTS 配音轨）。render 流程里
  panel 视频本就是无音的，音轨在 group 拼接/合并阶段另加，所以直接用 desub 视频无误。
