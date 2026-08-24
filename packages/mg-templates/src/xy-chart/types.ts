export type MotionMode = "ease" | "instant";

export type AxisSpec = {
  min: number;
  max: number;
  label: string;
  unit: string;
  ticks: number;
};

export type XYChartKeyframe = {
  /** Seconds from the beginning of this scene. The point is reached at this time. */
  at: number;
  x: number;
  y: number;
  label: string;
  /** The motion from the previous keyframe to this keyframe. */
  motion: MotionMode;
};

export type XYChartSpec = {
  title: string;
  axes: {
    x: AxisSpec;
    y: AxisSpec;
  };
  keyframes: XYChartKeyframe[];
};

export type ChartPoint = Pick<XYChartKeyframe, "x" | "y" | "label">;

export type XYChartTheme = {
  background: string;
  panel: string;
  ink: string;
  muted: string;
  grid: string;
  accent: string;
};
