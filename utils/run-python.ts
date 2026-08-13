/**
 * run-python.ts — 全局路径常量
 *
 * CONFIG_DIR  ~/.story-claw/   配置文件（config.json, image_gen_config.json）
 * WORK_DIR    process.cwd()        工作目录（workspace/, agent-data/, 小说源文件夹）
 */

import os from "node:os";
import path from "node:path";

/** 用户配置目录 */
export const CONFIG_DIR = path.join(os.homedir(), ".story-claw");

/** 工作目录（运行 CLI 时的 cwd） */
export const WORK_DIR = process.cwd();
