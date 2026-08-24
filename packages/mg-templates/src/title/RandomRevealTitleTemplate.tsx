import {CSSProperties} from "react";
import {useCurrentFrame, useVideoConfig} from "remotion";
import {clamp01, easeOutCubic, titleElapsed, titleHasStarted} from "./evaluate";
import {TitleLayout} from "./TitleLayout";
import {TitleSpec} from "./types";

type Props = {spec: TitleSpec; style?: CSSProperties};
const hash = (index: number, sequence: number) => ((index * 47 + sequence * 31) % 101) / 101;

export const RandomRevealTitleTemplate = ({spec, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  if (!titleHasStarted(spec, seconds)) return null;
  const elapsed = titleElapsed(spec, seconds);
  return <TitleLayout spec={spec} style={style}>{Array.from(spec.text).map((character, index) => {
    const delay = hash(index, spec.sequence ?? 1) * 0.7;
    const progress = easeOutCubic(clamp01((elapsed - delay) / 0.35));
    return <span key={`${index}-${character}`} style={{display: "inline-block", whiteSpace: character === " " ? "pre" : undefined, opacity: progress, transform: `translateY(${(1 - progress) * 20}px) scale(${0.9 + progress * 0.1})`}}>{character}</span>;
  })}</TitleLayout>;
};
