import {CSSProperties} from "react";
import {useCurrentFrame, useVideoConfig} from "remotion";
import {easeOutCubic, titleElapsed, titleHasStarted} from "./evaluate";
import {TitleLayout} from "./TitleLayout";
import {TitleSpec} from "./types";

type Props = {spec: TitleSpec; style?: CSSProperties};

export const FadeTitleTemplate = ({spec, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  if (!titleHasStarted(spec, seconds)) return null;
  const progress = easeOutCubic(titleElapsed(spec, seconds) / 0.65);
  return <TitleLayout spec={spec} style={style} opacity={progress} transform={`translateY(${(1 - progress) * 18}px)`}>{spec.text}</TitleLayout>;
};
