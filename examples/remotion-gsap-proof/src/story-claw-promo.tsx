import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const STORY_CLAW_PROMO_FPS = 30;
export const STORY_CLAW_PROMO_DURATION_IN_FRAMES = 1080; // 36 seconds

type PromoProps = {
  bgm?: boolean;
  sfx?: boolean;
};

const ASSET_ROOT = 'story-claw-promo';
const MEDIA = (name: string) => staticFile(`${ASSET_ROOT}/media/${name}`);
const AUDIO_SRC = (name: string) => staticFile(`${ASSET_ROOT}/audio/${name}`);

const COLORS = {
  black: '#090708',
  wine: '#2b0b0d',
  red: '#9f1f17',
  orange: '#ff6a1a',
  amber: '#ffad32',
  cream: '#fff4e7',
  muted: 'rgba(255,244,231,.66)',
};

const ease = Easing.bezier(0.2, 0.82, 0.22, 1);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const progress = (frame: number, from: number, to: number, easing = ease) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });

const sceneOpacity = (frame: number, from: number, to: number, fade = 18) =>
  interpolate(frame, [from, from + fade, to - fade, to], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.linear,
  });

const Gradient: React.FC<{variant?: 'warm' | 'dark' | 'ember'}> = ({variant = 'warm'}) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, STORY_CLAW_PROMO_DURATION_IN_FRAMES], [0, 8], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const background =
    variant === 'dark'
      ? `linear-gradient(132deg, #070607 0%, #18090b 50%, #6f1c16 100%)`
      : variant === 'ember'
        ? `linear-gradient(118deg, #0a0708 0%, #3b0d0d 38%, #a92516 72%, #ff7a1d 100%)`
        : `linear-gradient(124deg, #090708 0%, #250b0c 40%, #ae2917 74%, #ff8121 100%)`;

  return (
    <AbsoluteFill style={{background, overflow: 'hidden'}}>
      <div
        style={{
          position: 'absolute',
          inset: '-10%',
          opacity: 0.16,
          transform: `translateX(${drift}px)`,
          background: 'linear-gradient(90deg, transparent 0%, rgba(255,184,84,.22) 48%, transparent 78%)',
          mixBlendMode: 'screen',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(0,0,0,.1), rgba(0,0,0,.3))',
        }}
      />
    </AbsoluteFill>
  );
};

const Logo: React.FC<{size: number; opacity?: number; scale?: number}> = ({size, opacity = 1, scale = 1}) => (
  <Img
    src={MEDIA('storyclaw-logo.png')}
    style={{
      width: size,
      height: size,
      objectFit: 'contain',
      opacity,
      transform: `scale(${scale})`,
      filter: 'drop-shadow(0 16px 28px rgba(0,0,0,.34))',
    }}
  />
);

const BigType: React.FC<{
  children: React.ReactNode;
  x: number;
  y: number;
  size?: number;
  color?: string;
  weight?: number;
  delay?: number;
  width?: number;
  lineHeight?: number;
}> = ({children, x, y, size = 92, color = COLORS.cream, weight = 700, delay = 0, width, lineHeight = 1.08}) => {
  const frame = useCurrentFrame();
  const enter = progress(frame, delay, delay + 26);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        color,
        fontFamily: '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: size,
        fontWeight: weight,
        lineHeight,
        letterSpacing: 0,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [38, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

const AccentRule: React.FC<{x: number; y: number; width: number; delay: number}> = ({x, y, width, delay}) => {
  const frame = useCurrentFrame();
  const p = progress(frame, delay, delay + 34);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: width * p,
        height: 6,
        borderRadius: 99,
        background: `linear-gradient(90deg, ${COLORS.orange}, ${COLORS.amber})`,
        boxShadow: '0 6px 20px rgba(255,94,26,.28)',
      }}
    />
  );
};

const ScreenshotPanel: React.FC<{
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  from: number;
  delay?: number;
  rotateY?: number;
  rotateZ?: number;
  objectPosition?: string;
  zIndex?: number;
}> = ({src, x, y, width, height, from, delay = 0, rotateY = 0, rotateZ = 0, objectPosition = 'center', zIndex = 2}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame: Math.max(0, frame - from - delay),
    fps,
    config: {damping: 18, stiffness: 92, mass: 0.82},
    durationInFrames: 42,
  });
  const visible = progress(frame, from + delay - 4, from + delay + 18);
  const startX = x + (x > 800 ? 180 : -180);
  const startY = y + 50;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        zIndex,
        overflow: 'hidden',
        borderRadius: 22,
        border: '1px solid rgba(255,244,231,.25)',
        background: '#111011',
        boxShadow: '0 30px 80px rgba(0,0,0,.42), 0 0 0 1px rgba(255,105,31,.08)',
        opacity: visible,
        transformOrigin: 'center center',
        transform: `perspective(1500px) translate3d(${interpolate(enter, [0, 1], [startX, x]) - x}px, ${interpolate(enter, [0, 1], [startY, y]) - y}px, 0) rotateY(${interpolate(enter, [0, 1], [rotateY + 4, rotateY])}deg) rotateZ(${interpolate(enter, [0, 1], [rotateZ + 1.4, rotateZ])}deg) scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
      }}
    >
      <Img
        src={MEDIA(src)}
        style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition, display: 'block'}}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(135deg, rgba(255,255,255,.12), transparent 22%, transparent 72%, rgba(0,0,0,.22))',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};

const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const logoP = spring({frame, fps: 30, config: {damping: 16, stiffness: 90}, durationInFrames: 38});
  const bar = progress(frame, 38, 78);
  return (
    <AbsoluteFill style={{opacity: sceneOpacity(frame, 0, 168)}}>
      <Gradient variant="warm" />
      <div style={{position: 'absolute', left: 164, top: 184, transform: `translateY(${interpolate(logoP, [0, 1], [26, 0])}px)`}}>
        <Logo size={142} opacity={logoP} scale={interpolate(logoP, [0, 1], [0.78, 1])} />
      </div>
      <BigType x={166} y={406} size={112} delay={30} width={1120}>
        把内容，做成成片。
      </BigType>
      <div
        style={{
          position: 'absolute',
          left: 172,
          top: 558,
          color: COLORS.muted,
          fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
          fontSize: 30,
          opacity: progress(frame, 58, 88),
          transform: `translateY(${interpolate(progress(frame, 58, 88), [0, 1], [16, 0])}px)`,
        }}
      >
        Story Claw
      </div>
      <div style={{position: 'absolute', left: 172, top: 620, width: 360 * bar, height: 6, background: COLORS.orange, borderRadius: 99}} />
      <div style={{position: 'absolute', right: 170, bottom: 122, color: 'rgba(255,244,231,.42)', fontSize: 18, letterSpacing: 3, opacity: progress(frame, 80, 108)}}>
        STORY · MOTION · OUTPUT
      </div>
    </AbsoluteFill>
  );
};

const InputScene: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = sceneOpacity(frame, 148, 390);
  return (
    <AbsoluteFill style={{opacity: alpha}}>
      <Gradient variant="dark" />
      <BigType x={132} y={250} size={104} delay={160} width={650}>
        一段文字
        <br />
        开始制作
      </BigType>
      <AccentRule x={140} y={526} width={180} delay={220} />
      <div
        style={{
          position: 'absolute',
          left: 142,
          top: 570,
          color: COLORS.muted,
          fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
          fontSize: 27,
          opacity: progress(frame, 220, 250),
        }}
      >
        小说 · 文章 · 结构化内容
      </div>
      <ScreenshotPanel
        src="story-claw-home-current.png"
        x={790}
        y={184}
        width={1000}
        height={516}
        from={174}
        rotateY={-7}
        rotateZ={-1.1}
        objectPosition="center"
      />
      <div style={{position: 'absolute', right: 165, bottom: 114, color: 'rgba(255,244,231,.48)', fontSize: 18, letterSpacing: 2, opacity: progress(frame, 226, 256)}}>
        INPUT
      </div>
    </AbsoluteFill>
  );
};

const WorkflowScene: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = sceneOpacity(frame, 368, 660);
  const breathe = interpolate(frame, [430, 520, 640], [0, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.sin)});
  return (
    <AbsoluteFill style={{opacity: alpha}}>
      <Gradient variant="ember" />
      <BigType x={142} y={106} size={84} delay={382} width={980}>
        完整制作流程
      </BigType>
      <div style={{position: 'absolute', left: 150, top: 222, width: 140, height: 5, borderRadius: 99, background: COLORS.amber, opacity: progress(frame, 410, 438)}} />
      <div style={{position: 'absolute', left: 150, top: 252, color: COLORS.muted, fontSize: 28, opacity: progress(frame, 420, 450)}}>
        分镜 · 配音 · 渲染
      </div>
      <ScreenshotPanel
        src="story-claw-episode.png"
        x={174}
        y={322}
        width={1572}
        height={620}
        from={398}
        rotateY={0}
        rotateZ={0}
        objectPosition="center 46%"
      />
      <div style={{position: 'absolute', left: 174, top: 322, width: 1572, height: 620, borderRadius: 22, border: `2px solid rgba(255,153,61,${0.12 + breathe * 0.12})`, pointerEvents: 'none'}} />
    </AbsoluteFill>
  );
};

const AssetsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = sceneOpacity(frame, 638, 906);
  return (
    <AbsoluteFill style={{opacity: alpha}}>
      <Gradient variant="dark" />
      <BigType x={142} y={110} size={108} delay={654} width={800}>
        资产管理
      </BigType>
      <div style={{position: 'absolute', left: 150, top: 268, color: COLORS.muted, fontSize: 29, opacity: progress(frame, 680, 710)}}>
        MG · 人物 · 场景
      </div>
      <ScreenshotPanel
        src="story-claw-assets-mg.png"
        x={142}
        y={354}
        width={820}
        height={430}
        from={688}
        rotateY={8}
        rotateZ={-1.8}
        objectPosition="center"
        zIndex={2}
      />
      <ScreenshotPanel
        src="story-claw-assets-people.png"
        x={956}
        y={294}
        width={820}
        height={430}
        from={710}
        rotateY={-7}
        rotateZ={1.8}
        objectPosition="center"
        zIndex={3}
      />
      <div style={{position: 'absolute', right: 152, bottom: 118, width: 160, height: 5, background: COLORS.orange, borderRadius: 99, opacity: progress(frame, 760, 792)}} />
    </AbsoluteFill>
  );
};

const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const alpha = sceneOpacity(frame, 884, STORY_CLAW_PROMO_DURATION_IN_FRAMES);
  const logoP = spring({frame: Math.max(0, frame - 930), fps: 30, config: {damping: 18, stiffness: 82}, durationInFrames: 48});
  const titleP = progress(frame, 950, 988);
  return (
    <AbsoluteFill style={{opacity: alpha}}>
      <Gradient variant="warm" />
      <div style={{position: 'absolute', left: 0, right: 0, top: 170, display: 'flex', justifyContent: 'center', transform: `translateY(${interpolate(logoP, [0, 1], [30, 0])}px)`}}>
        <Logo size={184} opacity={logoP} scale={interpolate(logoP, [0, 1], [0.72, 1])} />
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 404, textAlign: 'center', color: COLORS.cream, fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif', fontSize: 82, fontWeight: 700, opacity: titleP, transform: `translateY(${interpolate(titleP, [0, 1], [24, 0])}px)`}}>
        Story Claw
      </div>
      <div style={{position: 'absolute', left: 0, right: 0, top: 530, textAlign: 'center', color: COLORS.muted, fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif', fontSize: 32, opacity: progress(frame, 980, 1014)}}>
        从内容到成片
      </div>
      <div style={{position: 'absolute', left: '50%', top: 622, width: 220 * progress(frame, 996, 1034), height: 6, transform: 'translateX(-50%)', borderRadius: 99, background: `linear-gradient(90deg, ${COLORS.orange}, ${COLORS.amber})`}} />
    </AbsoluteFill>
  );
};

const Soundtrack: React.FC<PromoProps> = ({bgm = true, sfx = true}) => {
  const frame = useCurrentFrame();
  const bgmVolume = interpolate(frame, [0, 30, STORY_CLAW_PROMO_DURATION_IN_FRAMES - 58, STORY_CLAW_PROMO_DURATION_IN_FRAMES], [0, 0.24, 0.24, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.linear,
  });
  return (
    <>
      {bgm ? <Audio src={AUDIO_SRC('house-vibez.mp3')} volume={bgmVolume} /> : null}
      {sfx ? (
        <>
          <Sequence from={142} durationInFrames={38}>
            <Audio src={AUDIO_SRC('transition-soft.mp3')} volume={0.26} />
          </Sequence>
          <Sequence from={174} durationInFrames={34}>
            <Audio src={AUDIO_SRC('whoosh-fast.mp3')} volume={0.28} />
          </Sequence>
          <Sequence from={396} durationInFrames={42}>
            <Audio src={AUDIO_SRC('whoosh-fast.mp3')} volume={0.24} />
          </Sequence>
          <Sequence from={686} durationInFrames={46}>
            <Audio src={AUDIO_SRC('impact-deep-whoosh.mp3')} volume={0.22} />
          </Sequence>
          <Sequence from={930} durationInFrames={44}>
            <Audio src={AUDIO_SRC('transition-soft.mp3')} volume={0.23} />
          </Sequence>
          <Sequence from={1000} durationInFrames={28}>
            <Audio src={AUDIO_SRC('sparkle-touch.mp3')} volume={0.2} />
          </Sequence>
        </>
      ) : null}
    </>
  );
};

export const StoryClawPromo: React.FC<PromoProps> = ({bgm = true, sfx = true}) => (
  <AbsoluteFill style={{background: COLORS.black}}>
    <IntroScene />
    <InputScene />
    <WorkflowScene />
    <AssetsScene />
    <OutroScene />
    <Soundtrack bgm={bgm} sfx={sfx} />
  </AbsoluteFill>
);
