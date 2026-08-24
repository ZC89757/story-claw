export type MultiSeriesChartType = "bar" | "line";

export type MultiSeriesChartDatum = {
  at: number;
  value: number;
};

export type MultiSeriesChartSeries = {
  name: string;
  data: MultiSeriesChartDatum[];
};

export type MultiSeriesChartSpec = {
  chartType: MultiSeriesChartType;
  title: string;
  xAxis: {
    label: string;
    categories: string[];
  };
  yAxis: {
    min: number;
    max: number;
    label: string;
    unit: string;
    ticks: number;
  };
  series: MultiSeriesChartSeries[];
};
