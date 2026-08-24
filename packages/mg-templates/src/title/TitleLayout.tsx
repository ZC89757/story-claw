import {CSSProperties, ReactNode} from "react";
import {AbsoluteFill} from "remotion";
import {TitleSpec} from "./types";

type Props = {
  spec: TitleSpec;
  children: ReactNode;
  opacity?: number;
  transform?: string;
  style?: CSSProperties;
};

export const titleFontSize = (text: string) => text.length > 36 ? 54 : text.length > 24 ? 66 : text.length > 14 ? 78 : 92;

export const TitleLayout = ({spec, children, opacity = 1, transform, style}: Props) => <AbsoluteFill style={{background: "transparent", fontFamily: '"Microsoft YaHei", Arial, sans-serif', color: "#f7f8f8", display: "flex", alignItems: "center", justifyContent: "center", ...style}}>
  <div style={{display: "flex", flexDirection: "column", alignItems: "center", width: 1640, opacity, transform}}>
    {spec.sequence === undefined ? null : <div style={{width: 104, height: 104, borderRadius: "50%", border: "5px solid #ef5b2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48, lineHeight: 1, fontWeight: 900, color: "#f5f7f7", marginBottom: 58, boxSizing: "border-box", textShadow: "0 3px 14px rgba(0,0,0,.5)"}}>{spec.sequence}</div>}
    <div style={{width: "100%", minHeight: 130, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: titleFontSize(spec.text), lineHeight: 1.25, fontWeight: 900, overflowWrap: "anywhere", textShadow: "0 5px 24px rgba(0,0,0,.75)", letterSpacing: 0}}>{children}</div>
  </div>
</AbsoluteFill>;
