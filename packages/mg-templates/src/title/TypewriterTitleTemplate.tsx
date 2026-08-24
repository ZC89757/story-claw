import {CSSProperties} from "react";
import {useCurrentFrame, useVideoConfig} from "remotion";
import {titleHasStarted, titleElapsed} from "./evaluate";
import {TitleLayout} from "./TitleLayout";
import {TitleSpec} from "./types";

type Props = {spec: TitleSpec; style?: CSSProperties};
const CHARACTERS_PER_SECOND = 14;

export const TypewriterTitleTemplate = ({spec, style}: Props) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const seconds = frame / fps;
  if (!titleHasStarted(spec, seconds)) return null;
  const characters = Array.from(spec.text);
  const count = Math.min(characters.length, Math.floor(titleElapsed(spec, seconds) * CHARACTERS_PER_SECOND) + 1);
  return <TitleLayout spec={spec} style={style}>{characters.slice(0, count).join("")}<span style={{color: "#ef5b2a"}}>│</span></TitleLayout>;
};
