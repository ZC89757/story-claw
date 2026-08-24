export type TimedTableCell = {
  at: number;
  text: string;
};

export type TimedTableSpec = {
  size: {
    rows: number;
    columns: number;
  };
  /** Row-major cells: left to right, then top to bottom. */
  cells: TimedTableCell[];
};
