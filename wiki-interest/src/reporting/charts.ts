import * as echarts from 'echarts';
import type { Entry } from '../analysis.js';
import { text, type Locale } from './locale.js';

export function renderChart(entries: Entry[], locale: Locale, kind: 'absolute' | 'relative', fontCss = '', labels: Record<string, string> = {}): string {
  const months = entries[0]?.metrics.monthly.map(m => m.month) ?? [];
  if (entries.some(e => e.metrics.monthly.map(m => m.month).join() !== months.join())) throw new Error('Періоди графіка не збігаються.');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 710, height: 180 });
  try {
    chart.setOption({ animation: false, backgroundColor: '#ffffff', textStyle: { fontFamily: 'Noto Sans', fontSize: 11 },
      title: { text: text[locale][kind], left: 0, top: 0, textStyle: { fontFamily: 'Noto Sans', fontSize: 12, fontWeight: 'normal', color: '#172c42' } },
      color: ['#116eaa', '#be4b21', '#298045', '#8053a1'],
      legend: { top: 23, left: 0, itemWidth: 16, itemHeight: 3, textStyle: { fontFamily: 'Noto Sans', fontSize: 11 } },
      grid: { left: 68, right: 16, top: 68, bottom: 24 },
      xAxis: { type: 'category', data: months, boundaryGap: false, axisLabel: { fontSize: 10, hideOverlap: true }, axisLine: { lineStyle: { color: '#bdc9d4' } } },
      yAxis: { type: 'value', min: 0, axisLabel: { fontSize: 10 }, splitNumber: 3, splitLine: { lineStyle: { color: '#e8edf2' } } },
      series: entries.map((entry, i) => ({ name: `${labels[entry.topicId] ?? entry.topicId} · ${entry.language}`, type: 'line', animation: false, connectNulls: false, showSymbol: false,
        lineStyle: { width: 2, type: i % 2 ? 'dashed' : 'solid' },
        data: entry.metrics.monthly.map(m => kind === 'absolute' ? m.views.value : m.perMillion.value) })),
    });
    return chart.renderToSVGString().replace(/<defs\s*>/, `<defs><style type="text/css"><![CDATA[${fontCss}]]></style>`);
  } finally { chart.dispose(); }
}
