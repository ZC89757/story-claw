export type TitleSpec = {
  text: string;
  /** Scene-local second at which the title animation begins. */
  at: number;
  /** Only numbered-title variants display this value. */
  sequence?: number;
};
