import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {getMgTemplateProvider as ProviderFactory} from "@story-claw/mg-templates/provider";

export const MG_TEMPLATE_PROTOCOL_VERSION = 1;

type MgTemplateProvider = ReturnType<typeof ProviderFactory>;

type TemplatePackManifest = {
  name?: string;
  version?: string;
  protocolVersion?: number;
  provider?: string;
};

const defaultPackRoot = (): string => {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "StoryClaw", "mg-templates");
  return path.join(os.homedir(), ".story-claw", "mg-templates");
};

export const mgTemplatePackRoot = (): string => path.resolve(
  process.env.STORY_CLAW_MG_TEMPLATES_DIR?.trim() || defaultPackRoot(),
);

const missingPackError = (root: string): Error => new Error(
  `未安装 Story Claw MG Template Pack，或模板包不完整。请先安装与主程序兼容的模板包。\n模板目录: ${root}`,
);

let providerPromise: Promise<MgTemplateProvider> | null = null;

export async function loadMgTemplateProvider(): Promise<MgTemplateProvider> {
  if (providerPromise) return providerPromise;
  providerPromise = (async () => {
    const root = mgTemplatePackRoot();
    const manifestPath = path.join(root, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      if (process.env.STORY_CLAW_PACKAGED !== "1" || process.env.STORY_CLAW_DEV_TEMPLATES === "1") {
        const module = await import("@story-claw/mg-templates/provider");
        return module.getMgTemplateProvider();
      }
      throw missingPackError(root);
    }
    let manifest: TemplatePackManifest;
    try {
      manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8")) as TemplatePackManifest;
    } catch (error) {
      throw new Error(`MG Template Pack 清单损坏: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (manifest.protocolVersion !== MG_TEMPLATE_PROTOCOL_VERSION) {
      throw new Error(
        `MG Template Pack 接口版本不兼容：主程序需要 v${MG_TEMPLATE_PROTOCOL_VERSION}，当前为 v${String(manifest.protocolVersion ?? "未知")}。请更新模板包。`,
      );
    }
    const providerRelative = typeof manifest.provider === "string" && manifest.provider.trim()
      ? manifest.provider.trim()
      : "src/provider.js";
    const providerPath = path.resolve(root, providerRelative);
    if (providerPath !== root && !providerPath.startsWith(`${root}${path.sep}`)) throw new Error("MG Template Pack Provider 路径无效");
    if (!fs.existsSync(providerPath)) throw missingPackError(root);
    const module = await import(`${pathToFileURL(providerPath).href}?v=${encodeURIComponent(String(manifest.version ?? "0"))}`);
    if (typeof module.getMgTemplateProvider !== "function") throw new Error("MG Template Pack 未导出 getMgTemplateProvider()" );
    const provider = module.getMgTemplateProvider() as MgTemplateProvider;
    if (provider.protocolVersion !== MG_TEMPLATE_PROTOCOL_VERSION) {
      throw new Error(`MG Template Pack Provider 协议不兼容：${String(provider.protocolVersion)}`);
    }
    return provider;
  })().catch((error) => {
    providerPromise = null;
    throw error;
  });
  return providerPromise;
}
