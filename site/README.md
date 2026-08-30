# Story Claw 展示页

这是一个不依赖构建工具的静态页面，入口是 index.html。页面包含：

- 当前 Electron 桌面端的真实界面截图；
- 两条真实成片示例；
- GitHub 源码仓库和 GitHub Releases 入口；
- 页面打开时从 GitHub API 读取并展示仓库实时 Star 数；
- Windows 桌面端下载说明；
- 面向普通用户和开发者的两条入口；
- 截图放大和快速复制命令交互。

## 本地预览

在仓库根目录运行：

    python -m http.server 4173 --directory site

然后打开 http://127.0.0.1:4173/。

## GitHub Pages 建议

当前页面通过 GitHub Actions 将 site/ 目录部署到 GitHub Pages，在线地址为 https://zc89757.github.io/story-claw/。这样展示页和源码仍在同一个仓库，页面地址稳定，图片不会依赖本机路径。

## Windows 发布建议

普通用户下载的是 GitHub Release 的附件，不是仓库首页的 Code -> Download ZIP。每次打版本时建议上传：

- StoryClaw-Setup.exe：安装版；
- StoryClaw-Portable.zip：便携版；
- SHA256SUMS.txt：校验文件。

页面中的下载按钮固定指向 https://github.com/ZC89757/story-claw/releases/latest，以后更新版本时不用改网页。

页面中的 Star 数来自公开的 GitHub 仓库接口（`/repos/ZC89757/story-claw`），每次打开页面都会重新读取；如果 GitHub API 暂时限流，页面会保留 GitHub 链接并提示直接查看最新数据。
在首个 Release 之前，页面另提供 GitHub 主分支的源码 ZIP，方便开发者先行下载。

## 依赖边界

Electron 界面、Node 运行时和 Story Claw 代码可以放进 Windows 安装器。ComfyUI、LTX 模型、Python 环境、GPU 驱动和相关权重体积大且与硬件绑定，建议由安装器检测、引导配置或提供单独的渲染后端，而不是强行全部塞进桌面安装包。
