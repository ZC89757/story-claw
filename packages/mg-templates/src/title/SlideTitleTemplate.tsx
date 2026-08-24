import {CSSProperties} from "react";
import {useCurrentFrame, useVideoConfig} from "remotion";
import {easeOutCubic, titleElapsed, titleHasStarted} from "./evaluate";
import {TitleLayout} from "./TitleLayout";
import {TitleSpec} from "./types";

type Props = {spec: TitleSpec; style?: CSSProperties};

export const SlideTitleTemplate = ({spec, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  if (!titleHasStarted(spec, seconds)) return null;
  const progress = easeOutCubic(titleElapsed(spec, seconds) / 0.42);
  return <TitleLayout spec={spec} style={style} opacity={progress} transform={`translateX(${(1 - progress) * -1250}px)`}>{spec.text}</TitleLayout>;
};
