export const isGeneratedVideoTag = (tag: string | undefined): boolean =>
  tag === "sc-video" || tag === "sc-longtake";

/** Keep persisted document order; execute local clips first and lazily prepare GPU for a cache miss. */
export async function runVisualTaskQueue<T extends {htmlTag: string}>(
  records: readonly T[],
  render: (record: T, originalIndex: number, prepareGeneratedVideo: () => Promise<void>) => Promise<void>,
  beforeGeneratedVideo?: () => Promise<void>,
): Promise<void> {
  let preparation: Promise<void> | undefined;
  const prepare = () => preparation ??= Promise.resolve().then(() => beforeGeneratedVideo?.());
  const indexed = records.map((record, index) => ({record, index}));
  for (const {record, index} of [
    ...indexed.filter(({record}) => !isGeneratedVideoTag(record.htmlTag)),
    ...indexed.filter(({record}) => isGeneratedVideoTag(record.htmlTag)),
  ]) await render(record, index, prepare);
}
