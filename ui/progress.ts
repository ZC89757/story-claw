/**
 * 流水线实时进度展示
 */

export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageInfo {
  label: string;
  status: StageStatus;
  detail?: string;
  /** 多行附加信息（显示在阶段行下方） */
  subLines?: string[];
}

const STAGE_LABELS = ["A 剧本创作", "B 剧本解析", "C 资源生成", "E+F 分镜与画面"];

/** 生成进度条文本 */
export function progressBar(done: number, total: number, width = 16): string {
  if (total <= 0) return "░".repeat(width) + " 0/0";
  const ratio = Math.min(done / total, 1);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled) + ` ${done}/${total}`;
}

export function createProgress() {
  const stages: StageInfo[] = STAGE_LABELS.map((label) => ({
    label,
    status: "pending" as StageStatus,
  }));

  function render(title: string) {
    // 清屏后重绘
    console.clear();
    console.log(`\n  ${title}`);
    console.log("  " + "=".repeat(50) + "\n");

    for (const s of stages) {
      const icon =
        s.status === "done" ? "v" :
        s.status === "running" ? "*" :
        s.status === "failed" ? "x" :
        " ";
      const statusText =
        s.status === "done" ? "完成" :
        s.status === "running" ? "进行中" :
        s.status === "failed" ? "失败" :
        "";
      const dots = ".".repeat(Math.max(0, 18 - s.label.length));
      const detail = s.detail ? `  ${s.detail}` : "";
      console.log(`  ${icon} ${s.label} ${dots} ${statusText}${detail}`);

      // 渲染多行附加信息
      if (s.subLines) {
        for (const line of s.subLines) {
          console.log(`      ${line}`);
        }
      }
    }
    console.log();
  }

  return {
    stages,
    /** 标记某阶段开始 */
    start(index: number, title: string, detail?: string) {
      stages[index].status = "running";
      stages[index].detail = detail;
      render(title);
    },
    /** 标记某阶段完成 */
    done(index: number, title: string, detail?: string) {
      stages[index].status = "done";
      stages[index].detail = detail;
      stages[index].subLines = undefined;
      render(title);
    },
    /** 标记某阶段失败 */
    fail(index: number, title: string, detail?: string) {
      stages[index].status = "failed";
      stages[index].detail = detail;
      render(title);
    },
    /** 更新某阶段的 detail（不改状态） */
    update(index: number, title: string, detail: string) {
      stages[index].detail = detail;
      render(title);
    },
    /** 更新某阶段的多行附加信息 */
    updateSubLines(index: number, title: string, subLines: string[]) {
      stages[index].subLines = subLines;
      render(title);
    },
    render,
  };
}
