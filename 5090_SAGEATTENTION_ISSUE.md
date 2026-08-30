# 5090 SageAttention 未适配问题

## 现状

5090（117.50.171.210）的 ComfyUI 启动参数带 `--use-sage-attention`，但实际每次 attention 调用都会先报错再降级：

```
[2026-07-12 02:10:24.500] Error running sage attention: CUDA error: no kernel image is available for execution on the device
, using pytorch attention instead.
```

（这条日志在一次生成里重复出现几十次，每个 attention 层都要失败一次再降级。）

## 根因（已用 `cuobjdump` 实锤确认，不是猜测）

- torch 正确识别出显卡：`torch.cuda.get_device_capability(0) == (12, 0)`（Blackwell / 5090）
- 但已编译的 SageAttention（2.2.0，源码在 `/root/SageAttention`，editable 安装）编译产物只有：
  - `_qattn_sm80.cpython-310-x86_64-linux-gnu.so`（Ampere）
  - `_qattn_sm89.cpython-310-x86_64-linux-gnu.so`（Ada Lovelace，即 **4090** 的架构）
  - 用 `cuobjdump --list-elf` 直接看编译产物，cubin 标的就是 `sm_89`
  - **没有 sm_120（Blackwell）的编译产物**
- `SageAttention/setup.py` 里 `SUPPORTED_ARCHS = {"8.0", "8.6", "8.9", "9.0", "12.0"}`，本来是支持 12.0 的，只是**从没针对这块 5090 重新编译过**

结论：这套环境（含已编译的二进制扩展）是在 4090 机器上装好后原样搬到 5090 的，SageAttention 的原生扩展从未针对 5090 重新编译。每次调用都是「尝试 sm_89 kernel → CUDA 报错 → 捕获异常降级为 pytorch 原生 attention」，白白多了一层失败开销，且实际跑的是远慢于 SageAttention 的朴素实现。

## 修复方案

在 5090 机器上（保证当前挂载的就是这块卡）重新编译：

```bash
cd /root/SageAttention
export PATH="/usr/local/cuda-12.8/bin:$PATH"   # nvcc 存在但不在 PATH 里
pip install -e . --force-reinstall --no-deps
```

`setup.py` 会自动探测当前机器上的 GPU compute capability（这台机器现在只有 5090，探测结果应为 `12.0`），编译出对应的 `_qattn_sm120*.so`。编译完成后需要 `supervisorctl restart comfyui`（或对应服务名）让新扩展生效。

**风险/注意事项**：
- 编译期间及重启 ComfyUI 会造成该机器短暂不可用（生产影响）
- 建议先备份现存的 `sageattention/*.so`，编译失败可回滚
- 编译耗时未知（含 CUDA kernel 编译，可能数分钟）

## 修复执行记录（2026-07-12，已完成）

- 执行窗口：编译前确认 `/queue` 为空、GPU 利用率 0%，无生产任务受影响
- 备份：原 `sm_89` 产物备份至 `/root/sageattention_sm89_backup_20260712/`
- **关键坑**：`pip install -e . --force-reinstall --no-deps` 第一次没有真正重新编译——setuptools 的 `build_ext` 按源码 mtime 判断"无需重编译"，直接复用了旧的 `build/` 缓存，产物 mtime 未变。需先 `rm -rf build/ sageattention.egg-info/ sageattention/*.so` 清空缓存再重装，才会真正触发 `nvcc`
- 清缓存后重装，`nvcc` 命令行确认带 `-gencode arch=compute_120,code=sm_120`
- `cuobjdump --list-elf` 验证产物：`_qattn_sm89.*.so` 和 `_qattn_sm80.*.so`（文件名沿用源码文件名 `qk_int_sv_f16_cuda_sm80/89.cu`，与目标架构无关）内部 cubin 均已变为 `sm_120`
- 用 `/start.d/comfyui.sh`（`kill` 旧进程 + 重跑该脚本）重启 ComfyUI，无 supervisor 管理，父进程是 `tini`
- 验证：直接调用 `sageattn(q,k,v)` 跑通，无 `CUDA error: no kernel image is available` 报错

## 预期效果

SageAttention 相比 pytorch 原生 attention 通常有数倍级别的加速（INT8/FP8 量化 attention kernel vs. 朴素实现），且能省掉每层「失败重试再降级」的额外开销。修复后 5090 的 i2v / 去字幕生成耗时预计会有明显下降——保守估计跟当前 4090（用的是正确匹配架构的 `sm_89` SageAttention kernel）的差距应至少能追平，考虑到 5090 本身算力规格更高，理论上应明显反超，而不是像目前基准测试里那样只领先 30%~45%（那个领先幅度本身就是在 5090 attention 降级的情况下测出来的，修复后差距应该更大）。

具体提速数字需要修复后重新跑一遍基准测试才能给出。
