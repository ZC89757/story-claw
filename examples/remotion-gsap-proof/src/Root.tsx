import {Composition} from "remotion";
import {ApiValueMathMG, ApiValueMathMGDebug} from "./api-value-math-mg";
import {CoffeeCostGsap, CoffeeCostRemotion} from "./coffee-cost-mg";
import {COMPONENT_LIBRARY_DURATION_IN_FRAMES, ComponentLibraryShowcase} from "./component-library-showcase";
import {UNITREE_IPO_DURATION_IN_FRAMES, UnitreeIpoMg} from "./unitree-ipo-mg";
import {
  PARAMETERIZED_CHART_DURATION_IN_FRAMES,
  PARAMETERIZED_CHART_FPS,
  ParameterizedChartEase,
  ParameterizedChartInstant,
} from "./parameterized-chart-demo";
import {
  COMPANY_OUTPUT_DURATION_IN_FRAMES,
  COMPANY_OUTPUT_FPS,
  CompanyOutputChart,
} from "./company-output-chart";
import {STORY_CLAW_PROMO_DURATION_IN_FRAMES, STORY_CLAW_PROMO_FPS, StoryClawPromo} from "./story-claw-promo";

export const FPS = 30;
export const DURATION_IN_FRAMES = 180;

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="CoffeeCostRemotion"
        component={CoffeeCostRemotion}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="CoffeeCostGsap"
        component={CoffeeCostGsap}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="ApiValueMathMG"
        component={ApiValueMathMG}
        durationInFrames={348}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="ApiValueMathMGDebug"
        component={ApiValueMathMGDebug}
        durationInFrames={348}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="ComplexMotionShowcase"
        component={ComponentLibraryShowcase}
        durationInFrames={COMPONENT_LIBRARY_DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="UnitreeIpoMg"
        component={UnitreeIpoMg}
        durationInFrames={UNITREE_IPO_DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="ParameterizedChartEase"
        component={ParameterizedChartEase}
        durationInFrames={PARAMETERIZED_CHART_DURATION_IN_FRAMES}
        fps={PARAMETERIZED_CHART_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="ParameterizedChartInstant"
        component={ParameterizedChartInstant}
        durationInFrames={PARAMETERIZED_CHART_DURATION_IN_FRAMES}
        fps={PARAMETERIZED_CHART_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="CompanyOutputChart"
        component={CompanyOutputChart}
        durationInFrames={COMPANY_OUTPUT_DURATION_IN_FRAMES}
        fps={COMPANY_OUTPUT_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="StoryClawPromo"
        component={StoryClawPromo}
        durationInFrames={STORY_CLAW_PROMO_DURATION_IN_FRAMES}
        fps={STORY_CLAW_PROMO_FPS}
        width={1920}
        height={1080}
        defaultProps={{bgm: true, sfx: true}}
      />
    </>
  );
};
