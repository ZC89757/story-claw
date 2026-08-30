import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ttsExecApi } from "../../runner/render.ts";


const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(here, "input", "news.mp3");
const text = "这里是今日科技快讯，欢迎收看。";
const voice = "zh_female_gaolengyujie_moon_bigtts";

await fs.mkdir(path.dirname(output), { recursive: true });
await ttsExecApi(text, voice, "专业、沉稳的新闻播报", output);
console.log(output);

