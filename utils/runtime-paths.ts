import os from "node:os";
import path from "node:path";

const resolveOverride = (value: string | undefined, fallback: string): string =>
  value?.trim() ? path.resolve(value) : fallback;

/** User-owned configuration. The desktop app overrides this when needed. */
export const CONFIG_DIR = resolveOverride(
  process.env.STORY_CLAW_CONFIG_DIR,
  path.join(os.homedir(), ".story-claw"),
);

/** Writable runtime root containing workspace, agent-data, and agent-logs. */
export const WORK_DIR = resolveOverride(process.env.STORY_CLAW_WORK_DIR, process.cwd());
