import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {ttsExecApi} from "../../runner/render";

const TEXT = "第一年，我们公司实现总产值四十八万元。第二年，我们公司实现总产值九十六万元。第三年、第四年和第五年，总产值一直保持在九十六万元。第六年，我们公司的总产值达到近一千六百五十八万元。";
const projectDir = path.resolve(import.meta.dirname);
const publicAudioDir = path.join(projectDir, "public", "audio");
const outputAudio = path.join(publicAudioDir, "company-output-six-years.mp3");
const outputWav = path.join(publicAudioDir, "company-output-six-years.wav");
const outputTimestamps = path.join(projectDir, "src", "company-output-timestamps.json");
const outputSpec = path.join(projectDir, "src", "company-output-chart-spec.json");
const configPath = path.join(os.homedir(), ".story-claw", "tts_config.json");
const config = JSON.parse(await readFile(configPath, "utf8")) as {narrator_voice: string};

await mkdir(publicAudioDir, {recursive: true});
const result = await ttsExecApi(TEXT, config.narrator_voice, "", outputAudio, {timestamp: true});
if (result.words.length === 0) throw new Error("TTS returned no word timestamps");

await writeFile(outputTimestamps, `${JSON.stringify({text: TEXT, words: result.words}, null, 2)}\n`, "utf8");

type CharacterTiming = {character: string; startTime: number; endTime: number};
const characterTimeline: CharacterTiming[] = result.words.flatMap((word) => {
  const characters = Array.from(word.word.replace(/[^\p{L}\p{N}]/gu, ""));
  return characters.map((character) => ({character, startTime: word.startTime, endTime: word.endTime}));
});
const normalizedText = characterTimeline.map(({character}) => character).join("");
const findPhrase = (phrase: string, occurrence = 0) => {
  const normalizedPhrase = phrase.replace(/[^\p{L}\p{N}]/gu, "");
  let index = -1;
  let searchFrom = 0;
  for (let match = 0; match <= occurrence; match++) {
    index = normalizedText.indexOf(normalizedPhrase, searchFrom);
    if (index < 0) break;
    searchFrom = index + normalizedPhrase.length;
  }
  if (index < 0) throw new Error(`Cannot find phrase in TTS timestamps: ${phrase}`);
  return {
    start: characterTimeline[index].startTime,
    end: characterTimeline[index + normalizedPhrase.length - 1].endTime,
  };
};
const at = (seconds: number) => seconds.toFixed(3);
const firstYear = findPhrase("第一年");
const firstAmount = findPhrase("四十八万元");
const secondYear = findPhrase("第二年");
const secondAmount = findPhrase("九十六万元");
const thirdYear = findPhrase("第三年");
const fourthYear = findPhrase("第四年");
const fifthYear = findPhrase("第五年");
const heldAmount = findPhrase("九十六万元", 1);
const sixthYear = findPhrase("第六年");
const sixthAmount = findPhrase("一千六百五十八万元");
const finalDuration = Number((result.words.at(-1)!.endTime + 0.8).toFixed(3));

const chartSpec = {
  axes: {
    x: {min: 0, max: 6, meaning: "经营年份", unit: "年", ticks: 7},
    y: {min: 0, max: 1800, meaning: "公司总产值", unit: "万元", ticks: 7},
  },
  keyframes: {
    "0.000": {x: 0, y: 0, label: "统计开始"},
    [at(firstAmount.end)]: {x: 1, y: 48, label: "第1年 · 48万"},
    [at(secondAmount.end)]: {x: 2, y: 96, label: "第2年 · 96万"},
    [at(thirdYear.end)]: {x: 3, y: 96, label: "第3年 · 持平"},
    [at(fourthYear.end)]: {x: 4, y: 96, label: "第4年 · 持平"},
    [at(fifthYear.end)]: {x: 5, y: 96, label: "第5年 · 持平"},
    [at(sixthYear.start)]: {x: 5, y: 96, label: "第6年开始"},
    [at(sixthAmount.end)]: {x: 6, y: 1658, label: "第6年 · 近1658万"},
  },
  movement: "ease",
  source: {
    text: TEXT,
    timestampFile: "company-output-timestamps.json",
    duration: finalDuration,
    sections: [
      {start: firstYear.start, end: firstAmount.end, title: "第一年", value: "48 万元"},
      {start: secondYear.start, end: secondAmount.end, title: "第二年", value: "96 万元"},
      {start: thirdYear.start, end: heldAmount.end, title: "第三至第五年", value: "连续持平"},
      {start: sixthYear.start, end: sixthAmount.end, title: "第六年", value: "近 1658 万元"},
    ],
  },
};

await writeFile(outputSpec, `${JSON.stringify(chartSpec, null, 2)}\n`, "utf8");
await promisify(execFile)("ffmpeg", ["-y", "-v", "error", "-err_detect", "ignore_err", "-i", outputAudio, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outputWav]);
console.log(JSON.stringify({audio: outputAudio, wav: outputWav, timestamps: outputTimestamps, spec: outputSpec, words: result.words.length, duration: finalDuration}, null, 2));
