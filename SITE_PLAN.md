# Story Claw 展示页与发布方案

## 当前交付

- 展示页：site/index.html
- 样式与交互：site/styles.css、site/script.js
- 真实界面截图：site/media/
- GitHub 实时 Star：首屏、顶部导航和能力概览条动态读取公开仓库数据
- 本地审阅截图：site/preview-desktop.png、site/preview-mobile.png
- 页面内所有下载入口统一指向：
  https://github.com/ZC89757/story-claw/releases/latest

当前仓库还没有正式 Windows 安装包，所以页面明确显示“等待首个正式 Release”，不会把一个不存在的文件伪装成下载链接。

页面的 Star 数不手工写死：打开页面时通过 GitHub 公开 API 读取 `ZC89757/story-claw` 的 `stargazers_count`，接口限流或暂不可用时回退为“—”并引导用户打开 GitHub 查看。

## 参考过的开源项目

- Ollama：首屏只强调一个结果，下载按钮常驻；README 的 Download 按操作系统分组。
- Tauri：官网先展示一句清楚的价值主张，再给 Get started、文档和 GitHub 入口。
- ComfyUI：版本发布集中在 GitHub Releases，每个版本有独立的说明和 Assets。
- LocalSend：桌面软件把安装文件作为 Release Assets 管理，而不是放在源码目录里。

因此 Story Claw 采用同样的分工：

| 入口 | 放什么 |
| --- | --- |
| 展示页 | 价值主张、真实截图、真实成片、下载导航 |
| GitHub 仓库 | 源码、README、问题反馈、开发文档 |
| GitHub Releases | Windows 安装包、便携包、校验文件、版本说明 |

## 推荐实施顺序

### 1. 先确认页面视觉

你先看 site/preview-desktop.png 和 site/preview-mobile.png，确认首屏语气、橙色品牌色、截图比例和文字是否符合预期。页面是纯静态 HTML，不需要先搭建前端构建系统。

### 2. 打包 Windows 桌面端

当前项目已经有 Electron 主进程和 renderer，但 package.json 还没有安装器配置。建议增加 electron-builder（NSIS + portable 两个目标）：

- StoryClaw-Setup.exe：普通用户的安装器；
- StoryClaw-Portable.zip：不想安装的用户；
- SHA256SUMS.txt：下载完整性校验。

桌面界面、Electron 运行时和项目代码可以打包。ComfyUI、LTX 模型、Python 环境、CUDA/GPU 驱动体积大且与机器绑定，不建议塞进同一个安装包。更稳妥的体验是安装器检查这些依赖，给出配置向导，并允许把渲染后端放在本机或远程 GPU 服务器。

### 3. 用 GitHub Actions 自动发布

给仓库增加 release workflow：

1. 推送版本标签，例如 v1.1.0；
2. Windows runner 构建 NSIS 和 portable；
3. 计算 SHA256；
4. 自动创建 GitHub Release 并上传三个附件；
5. 页面继续指向 Latest release，无需改 HTML。

### 4. 部署展示页

页面确认后，用 GitHub Pages 部署 site/ 目录。推荐 Actions 部署，避免把仓库根目录改成网页目录；部署完成后再把 Pages 地址补到 README 顶部和仓库 About 的 Website 字段。

### 5. 发布前检查

- 新用户能从页面首屏找到 Windows 下载和 GitHub；
- Releases 中确实存在 .exe 和 .zip；
- 安装后能打开桌面端；
- 没有 GPU 时有清楚的依赖提示；
- 页面截图和实际版本一致；
- README、页面和 Release 的版本号一致。

## 一个重要的取舍

“一个安装包包含所有东西”听起来简单，但会把 GPU 模型、Python、ComfyUI 和驱动问题都转移给安装器，下载体积也会非常大。第一版更适合把桌面端做成易安装的壳，把渲染服务做成可检测、可配置的后端；等依赖稳定后，再考虑提供全家桶镜像。
