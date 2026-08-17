import assert from "node:assert/strict";
import test from "node:test";
import {
  findSubtitleBoundaryWords,
  splitSubtitleText,
} from "../runner/subtitles.js";

test("uses the second comma when the first comma did not trigger a split", () => {
  const text = "按SoulAPI价格计算，生成全部10项解法的算力成本合计约2000美元，该数字仅指生成论证所消耗的token，不包括后续人工整理与形式化工作。";
  const chunks = splitSubtitleText(text, 18);
  const words = [
    { word: "按SoulAPI价格计算，", startTime: 0.385, endTime: 2.325 },
    { word: "生成全部10项解法的算力成本合计约2000美元，", startTime: 2.565, endTime: 6.565 },
    { word: "该数字仅指生成论证所消耗的token，", startTime: 7.007, endTime: 9.676 },
    { word: "不包括后续人工整理与形式化工作。", startTime: 9.9, endTime: 12.587 },
  ];

  assert.deepEqual(findSubtitleBoundaryWords(words, chunks), [1, 2, 3]);
});

test("consumes every skipped list delimiter before selecting the boundary", () => {
  const text = "甲、乙、丙、丁、戊、己。";
  const chunks = splitSubtitleText(text, 4);
  const words = [
    { word: "甲、", startTime: 0, endTime: 0.5 },
    { word: "乙、", startTime: 0.5, endTime: 1 },
    { word: "丙、", startTime: 1, endTime: 1.5 },
    { word: "丁、", startTime: 1.5, endTime: 2 },
    { word: "戊、", startTime: 2, endTime: 2.5 },
    { word: "己。", startTime: 2.5, endTime: 3 },
  ];

  assert.deepEqual(findSubtitleBoundaryWords(words, chunks), [1, 3, 5]);
});

test("matches equivalent Chinese and ASCII punctuation in sequence", () => {
  const chunks = splitSubtitleText("第一段，仍在继续，第二段。", 8);
  const words = [
    { word: "第一段,", startTime: 0, endTime: 1 },
    { word: "仍在继续,", startTime: 1, endTime: 2 },
    { word: "第二段。", startTime: 2, endTime: 3 },
  ];

  assert.deepEqual(findSubtitleBoundaryWords(words, chunks), [1, 2]);
});

test("uses the spoken clause comma when TTS omits a numeric comma", () => {
  const text = "协调式群体在 2,700 万 token 的运行中找到 266 个漏洞，独立并行方式在 650 万 token 中找到 21 个。";
  const chunks = splitSubtitleText(text.replace(/\s/g, ""), 18);
  const words = [
    { word: "协调式群体在两千七百万token的运行中找到二百六十六个漏洞，", startTime: 0, endTime: 6 },
    { word: "独立并行方式在六百五十万token中找到二十一个。", startTime: 6, endTime: 11 },
  ];

  assert.deepEqual(findSubtitleBoundaryWords(words, chunks), [0, 1]);
});
