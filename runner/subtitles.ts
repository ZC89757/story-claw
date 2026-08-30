export interface SubtitleWord {
  word: string;
  startTime: number;
  endTime: number;
}

export interface SubtitleChunk {
  text: string;
  boundaryPunct: string | null;
  hardBoundary?: boolean;
}

// 中英文标点正则（用 Unicode 转义避免源码中出现会被 esbuild 误解析的引号字符）
const PUNCT_RE = /[，。！？；：、“”‘’「」『』（）【】…—～,.!?;:"'()[\]]/;
const STRONG_SUBTITLE_PUNCT = new Set(["。", "！", "？", "!", "?"]);
const WEAK_SUBTITLE_PUNCT = new Set(["，", "、", "；", "：", ",", ";", ":"]);
const TIMING_SUBTITLE_PUNCT = new Set([
  ...STRONG_SUBTITLE_PUNCT,
  ...WEAK_SUBTITLE_PUNCT,
]);

function isPunct(ch: string): boolean {
  return PUNCT_RE.test(ch);
}

/** 去掉字符串末尾连续的标点符号和空白。 */
export function stripTrailingPunct(text: string): string {
  let i = text.length - 1;
  while (i >= 0 && (isPunct(text[i]) || text[i] === " ")) i--;
  return text.slice(0, i + 1);
}

/**
 * 原文字幕分段：句号/问号/感叹号强制切；逗号等仅在达到 maxChars 后切；
 * 没有中间标点则保持一个事件，后续只做 \N 换行。
 */
export function splitSubtitleText(text: string, maxChars: number): SubtitleChunk[] {
  const chunks: SubtitleChunk[] = [];
  let current = "";
  for (const ch of text) {
    current += ch;
    const strong = STRONG_SUBTITLE_PUNCT.has(ch);
    const weakAfterThreshold = current.length >= maxChars && WEAK_SUBTITLE_PUNCT.has(ch);
    const hardAfterTwoLines = current.length >= maxChars * 2;
    if (strong || weakAfterThreshold || hardAfterTwoLines) {
      chunks.push({
        text: current,
        boundaryPunct: strong || weakAfterThreshold ? ch : null,
        hardBoundary: hardAfterTwoLines && !strong && !weakAfterThreshold,
      });
      current = "";
    }
  }
  if (current) chunks.push({ text: current, boundaryPunct: null });
  return chunks.filter((chunk) => stripTrailingPunct(chunk.text));
}

function punctuationMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  if (expected === "，") return actual === ",";
  if (expected === ",") return actual === "，";
  if (expected === "；") return actual === ";";
  if (expected === ";") return actual === "；";
  if (expected === "：") return actual === ":";
  if (expected === ":") return actual === "：";
  if (expected === "！") return actual === "!";
  if (expected === "!") return actual === "！";
  if (expected === "？") return actual === "?";
  if (expected === "?") return actual === "？";
  return false;
}

/**
 * 按原文中的完整标点序列向前消费豆包 words，返回每条字幕结束的 word。
 * 未触发切分的早期逗号/顿号也必须消费；豆包省略数字等格式标点时，
 * 使用该字幕块最后一个实际返回的标点作为边界。
 */
export function findSubtitleBoundaryWords(
  words: SubtitleWord[],
  chunks: SubtitleChunk[],
): number[] {
  const boundaries: number[] = [];
  let searchWord = 0;
  let searchChar = 0;

  const findNextPunctuation = (punct: string): number => {
    for (let wi = searchWord; wi < words.length; wi++) {
      const chars = [...words[wi].word.replace(/\s/g, "")];
      const from = wi === searchWord ? searchChar : 0;
      for (let ci = from; ci < chars.length; ci++) {
        if (!punctuationMatches(chars[ci], punct)) continue;
        searchWord = wi;
        searchChar = ci + 1;
        if (searchChar >= chars.length) {
          searchWord = wi + 1;
          searchChar = 0;
        }
        return wi;
      }
    }
    return -1;
  };

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (chunk.hardBoundary && ci !== chunks.length - 1) {
      const targetChars = [...chunk.text].filter((ch) => !/\s/.test(ch)).length;
      let consumedChars = 0;
      let boundaryWord = -1;
      for (let wi = searchWord; wi < words.length; wi++) {
        const wordChars = [...words[wi].word.replace(/\s/g, "")].length;
        const nextConsumedChars = consumedChars + wordChars;
        if (nextConsumedChars < targetChars) {
          consumedChars = nextConsumedChars;
          continue;
        }
        const splitBefore = wi > searchWord && targetChars - consumedChars <= nextConsumedChars - targetChars;
        boundaryWord = splitBefore ? wi - 1 : wi;
        searchWord = boundaryWord + 1;
        searchChar = 0;
        break;
      }
      boundaries.push(boundaryWord >= 0 ? boundaryWord : Math.max(0, words.length - 1));
      continue;
    }
    if (ci === chunks.length - 1 || chunk.boundaryPunct === null) {
      boundaries.push(Math.max(searchWord, words.length - 1));
      continue;
    }

    const punctuationSequence = [...chunk.text].filter((ch) => TIMING_SUBTITLE_PUNCT.has(ch));
    let boundaryWord = -1;
    for (const punct of punctuationSequence) {
      const matchedWord = findNextPunctuation(punct);
      if (matchedWord >= 0) boundaryWord = matchedWord;
    }
    if (boundaryWord < 0) {
      boundaryWord = Math.min(searchWord, words.length - 1);
      searchWord = boundaryWord + 1;
      searchChar = 0;
    }
    boundaries.push(boundaryWord);
  }

  return boundaries;
}

/** 将过长的字幕文本按 maxChars 硬换行。 */
export function wrapSubtitleLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines: string[] = [];
  let rem = text;
  while (rem.length > maxChars) {
    lines.push(rem.slice(0, maxChars));
    rem = rem.slice(maxChars);
  }
  if (rem) lines.push(rem);
  return lines.join("\\N");
}
