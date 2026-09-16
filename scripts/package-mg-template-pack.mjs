import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const payloadRoot = path.join(projectRoot, "build", "mg-template-pack");
const scriptPath = path.join(projectRoot, "packaging", "mg-template-pack.nsi");
const manifestPath = path.join(payloadRoot, "manifest.json");
if (!fs.existsSync(manifestPath)) throw new Error("模板包 payload 不存在，请先运行 npm run build:templates");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packVersion = String(manifest.version || "0.0.0");
const outputPath = path.join(projectRoot, "release", `Story-Claw-MG-Template-Pack-Setup-${packVersion}.exe`);

const findRecursive = (root, fileName) => {
  if (!root || !fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const candidate = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate;
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
  return null;
};

const fromPath = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["makensis"], {encoding: "utf8"});
const cacheRoot = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "electron-builder", "Cache")
  : "";
const makensis = process.env.MAKENSIS?.trim()
  || (fromPath.status === 0 ? fromPath.stdout.split(/\r?\n/).find(Boolean)?.trim() : "")
  || findRecursive(cacheRoot, "makensis.exe");

if (!makensis || !fs.existsSync(makensis)) {
  throw new Error("找不到 makensis。请先安装 NSIS，或先构建主安装包以下载 electron-builder 的 NSIS 工具。" );
}
fs.mkdirSync(path.dirname(outputPath), {recursive: true});
const result = spawnSync(makensis, [
  `/DPAYLOAD_DIR=${payloadRoot}`,
  `/DOUTPUT_FILE=${outputPath}`,
  `/DPACK_VERSION=${packVersion}`,
  scriptPath,
], {stdio: "inherit"});
if (result.status !== 0) throw new Error(`makensis 失败，退出码 ${String(result.status)}`);
console.log(`[template-pack] installer: ${outputPath}`);
