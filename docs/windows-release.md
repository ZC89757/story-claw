# Windows 发布

两个 GitHub 仓库分别提供彼此独立的安装包：

- [`story-claw`](https://github.com/ZC89757/story-claw/releases) 发布 `Story-Claw-Setup-<version>.exe`：主程序。故事项目只需要安装它。
- [`story-claw-templates`](https://github.com/ZC89757/story-claw-templates/releases) 发布 `Story-Claw-MG-Template-Pack-Setup-<version>.exe`：可选 MG 模板包。议论文 MG 标注、Function Calling、模板预览和 Remotion 合成需要它。

模板包默认安装到 `%LOCALAPPDATA%\StoryClaw\mg-templates`。主程序读取 `manifest.json`，要求 `protocolVersion=1`，然后通过 Provider 的 `getMgTemplateProvider()` 取得函数定义、JSON Schema、解析器和渲染入口。未安装或协议不兼容时，主程序仍能启动并运行故事流程；进入议论文 MG 流程时会显示安装或更新提示。

## 本地构建

需要 Node.js 22.12 或更高版本：

```powershell
npm ci
npm run dist:win
```

输出位于 `release/`。本仓库只构建主安装包，不包含 Python、模型、ComfyUI 或模板素材。FFmpeg、FFprobe 和 Electron/Node 运行时随主安装包提供，用户无需另装。模板安装包在 `story-claw-templates` 仓库构建。

## GitHub 发布

推送 `v*` 标签后，`.github/workflows/release-windows.yml` 会在 Windows runner 上执行测试、生成主安装包并上传到本仓库的 GitHub Release。模板仓库使用自己的版本标签和 Release 工作流发布模板安装包。
