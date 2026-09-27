import type { Analysis, Entry, Finding } from '../analysis.js';
import { AppError } from '../errors.js';
import { escapeHtml as h, formatNumber, reasonText, shorten, text, type Locale } from './locale.js';
import { buildTopicHtml } from './topic-template.js';
import { buildCompletionHtml } from './completion-template.js';
import { sourceTable } from './source-table.js';

export interface Presentation { locale: Locale; rowIds: string[]; findingIds: string[] }
export function selectPresentation(analysis: Analysis, locale: Locale, rowIds?: string[], findingIds?: string[]): Presentation {
  const ordered = [...analysis.entries].sort((a, b) => {
    const score = (entry: Entry) => analysis.criterion === 'views' ? entry.metrics.totalViews.value : analysis.criterion === 'yearOverYear' ? entry.metrics.yearOverYear.changePercent.value : entry.metrics.yearOverYear.relativeChangePercent.value;
    return (score(b) ?? -Infinity) - (score(a) ?? -Infinity) || a.id.localeCompare(b.id, 'en');
  });
  if (rowIds?.some(id => !analysis.entries.some(e => e.id === id))) throw new AppError('REPORT_ROW_NOT_FOUND', 'Рядок представлення не належить до analysis.json.');
  if (findingIds?.some(id => !analysis.findings.some(f => f.id === id))) throw new AppError('FINDING_NOT_FOUND', 'ID висновку не належить до analysis.json.');
  const findingRows = [...new Set((findingIds ?? []).map(id => analysis.findings.find(f => f.id === id)!.evidenceId))];
  if (rowIds && findingRows.some(id => !rowIds.includes(id))) throw new AppError('FINDING_OUTSIDE_SELECTION', 'Висновок стосується рядка поза вибраним представленням.');
  const defaults = analysis.topicStudy ? [...analysis.topicStudy.rows.filter(r => r.role === 'core').slice(0, 3), ...analysis.topicStudy.rows.filter(r => r.role === 'root').slice(0, 1)].map(r => r.id) : ordered.map(e => e.id);
  const selectedRows = rowIds ?? [...new Set([...findingRows, ...defaults])].slice(0, 4);
  const defaultType = analysis.criterion === 'views' ? 'volume' : analysis.criterion === 'yearOverYear' ? 'annual_change' : 'relative_change';
  return { locale, rowIds: selectedRows, findingIds: findingIds ?? analysis.findings.filter(f => selectedRows.includes(f.evidenceId) && f.type === defaultType).slice(0, 2).map(f => f.id) };
}
export function findingSentence(finding: Finding, analysis: Analysis, locale: Locale): string {
  const t = text[locale], label = analysis.topics.find(topic => topic.topicId === finding.topicId)!.label;
  const unit = { views: '', views_per_day: '', views_per_million: '', percent: '%', percentage_points: locale === 'en' ? ' pp' : ' в.п.' }[finding.unit];
  const number = finding.value === null ? `${t.noData} (${finding.unavailableReason})` : `${formatNumber(finding.value, locale, finding.unit === 'views' ? 0 : 1)}${unit}`;
  return `${shorten(label, 42)} / ${finding.language}: ${t.types[finding.type]} — ${number}; ${finding.period.start}–${finding.period.end}${finding.baselinePeriod ? ` / ${finding.baselinePeriod.start}–${finding.baselinePeriod.end}` : ''}.`;
}
export interface TemplateResult { html: string; requiredText: string[]; expectedNumbers: string[]; omittedRows: string[]; omittedFindings: string[]; shortenedLabels: string[] }
export function buildHtml(analysis: Analysis, presentation: Presentation, charts: { absolute: string; relative: string }, fonts: string, chartMode: 'both' | 'absolute' | 'relative' = 'both'): TemplateResult {
  if (analysis.completion || analysis.recoveryEnabled) return buildCompletionHtml(analysis, presentation, charts, fonts);
  if (analysis.topicStudy) return buildTopicHtml(analysis, presentation, charts, fonts);
  const { locale } = presentation, t = text[locale];
  const entries = presentation.rowIds.map(id => analysis.entries.find(e => e.id === id)!);
  const omittedRows = analysis.entries.filter(e => !presentation.rowIds.includes(e.id)).map(e => e.id);
  const omittedFindings = analysis.findings.filter(f => !presentation.findingIds.includes(f.id)).map(f => f.id);
  const shortenedLabels = analysis.topics.filter(topic => shorten(topic.label, 42) !== topic.label).map(topic => topic.topicId);
  const label = (entry: Entry) => analysis.topics.find(topic => topic.topicId === entry.topicId)!.label;
  const abbreviations = new Map(analysis.topics.map(topic => [topic.topicId, shorten(topic.label, 42)]));
  const omittedGroups = analysis.topics.map(topic => `${abbreviations.get(topic.topicId)}: ${analysis.entries.filter(e => e.topicId === topic.topicId && omittedRows.includes(e.id)).map(e => e.language).join(', ')}`).filter(line => !line.endsWith(': '));
  const allConcepts = analysis.topics.map(topic => `${abbreviations.get(topic.topicId)} [${topic.selected.map(c => c.qid).join(', ')}]`).join('; ');
  const exclusions = analysis.topics.filter(topic => topic.excluded.length).map(topic => `${abbreviations.get(topic.topicId)}: ${topic.excluded.join(', ')}`).join('; ');
  const expectedNumbers: string[] = [];
  const number = (value: number | null, digits = 1) => { const formatted = formatNumber(value, locale, digits); if (value !== null) expectedNumbers.push(formatted); return h(formatted); };
  const requiredRows: string[] = [];
  const rows = entries.map((entry, i) => {
    const fields = [`${i + 1}. ${abbreviations.get(entry.topicId)!} / ${entry.language}`, formatNumber(entry.metrics.totalViews.value, locale, 0), formatNumber(entry.metrics.dailyAverage.value, locale), ...[entry.metrics.yearOverYear.changePercent.value, entry.metrics.yearOverYear.relativeChangePercent.value].map(value => value === null ? '—' : `${formatNumber(value, locale)}%`)];
    requiredRows.push(fields.join(' '));
    [entry.metrics.totalViews.value, entry.metrics.dailyAverage.value, entry.metrics.yearOverYear.changePercent.value, entry.metrics.yearOverYear.relativeChangePercent.value].forEach(value => number(value));
    return `<tr>${fields.map(field => `<td>${h(field)}</td>`).join('')}</tr>`;
  }).join('');
  const findings = presentation.findingIds.map(id => analysis.findings.find(f => f.id === id)!);
  for (const f of findings) if (f.value !== null) expectedNumbers.push(formatNumber(f.value, locale, f.unit === 'views' ? 0 : 1));
  const observations = findings.map(f => `<p data-finding-id="${h(f.id)}">${h(findingSentence(f, analysis, locale))}</p>`).join('');
  const statuses = entries.map((entry, i) => `${i + 1}: ${t.statuses[entry.diagnostic.status]}`).join('; ');
  const reasons = [...new Set(entries.flatMap(e => e.diagnostic.reasons.map(r => r.code)))];
  const reasonsShown = reasons.slice(0, 3).map(code => reasonText[code]?.[locale] ?? code).join(' ');
  const topicWarnings = analysis.warnings.filter(code => code === 'OVERLAPPING_TOPICS' || code === 'DIFFERENT_TOPIC_BREADTH').map(code => reasonText[code]![locale]).join(' ');
  const received = [...new Set(analysis.sources.map(s => s.receivedAt.slice(0, 10)))].sort();
  const retrieval = received.length ? `${received[0]}–${received.at(-1)}` : t.noData;
  const sections = [t.title, t.conclusion, t.metrics, t.quality, t.validation, t.sources];
  const scope = `${t.shortened}: ${presentation.rowIds.length}/${analysis.entries.length}; findings ${presentation.findingIds.length}/${analysis.findings.length}.${omittedRows.length ? ` ${t.omitted}: ${omittedGroups.join('; ')}.` : ''}`;
  const extraChart = chartMode === 'both' ? '' : ({ uk: 'Другий графік не ввійшов до PDF; обидва SVG збережено окремо.', en: 'The second chart is omitted from PDF; both SVG files are saved separately.', ru: 'Второй график не вошёл в PDF; оба SVG сохранены отдельно.' }[locale]);
  return { omittedRows, omittedFindings, shortenedLabels, requiredText: [...sections, ...requiredRows, analysis.runId, analysis.period.start, analysis.period.end, ...(analysis.source === 'fixtures' ? [t.synthetic] : [])], expectedNumbers,
    html: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'none'; connect-src 'none'; base-uri 'none'"><title>${h(t.title)}</title><style>
${fonts}
@page { size: A4 portrait; margin: 10mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: white; color: #203349; font-family: 'Noto Sans', sans-serif; font-size: 12px; line-height: 1.35; }
main { width: 190mm; margin: 0 auto; }
header { border-bottom: 2px solid #116eaa; padding-bottom: 5px; }
h1 { font-size: 23px; margin: 0 0 3px; font-weight: 600; }
h2 { font-size: 12px; margin: 8px 0 3px; color: #116eaa; font-weight: 600; }
p { margin: 3px 0; overflow-wrap: anywhere; }
.meta, .note, footer { font-size: 10.5px; line-height: 1.35; }
.badge { color: #964200; font-weight: 600; }
.scope { padding: 5px 7px; background: #eef4f8; }
.charts { margin-top: 6px; }
.chart { margin: 0; width: 710px; height: 180px; }
.chart svg { width: 710px; height: 180px; display: block; }
table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 11px; }
th, td { padding: 4px 5px; border-bottom: 1px solid #dce5ec; text-align: right; overflow-wrap: anywhere; }
th { background: #eef4f8; font-weight: 600; }
th:first-child, td:first-child { text-align: left; width: 29%; }
footer { border-top: 1px solid #bdc9d4; padding-top: 4px; margin-top: 6px; }
section, table, .chart { break-inside: avoid; }
</style></head><body><main>
<header><h1>${h(t.title)}</h1><p>${h(t.question)}</p><p class="meta"><span class="badge">${h(analysis.source === 'fixtures' ? t.synthetic : t.live)}</span> · ${h(t.period)}: ${analysis.period.start}–${analysis.period.end} · ${h(t.criterion)}: ${h(t.criteria[analysis.criterion])}</p></header>
<p class="note"><strong>${h(t.concepts)}:</strong> ${h(allConcepts)}</p>
${exclusions ? `<p class="note"><strong>${h(t.excluded)}:</strong> ${h(exclusions)}</p>` : ''}
<p class="note scope">${h(scope)} ${h(t.full)}${shortenedLabels.length ? ` ${h(t.shortenedLabels)}` : ''}</p>
<section><h2>${h(t.conclusion)}</h2>${observations}<p class="note">${h({ uk: 'Висновок обмежено вибраними статтями; одна загальна стаття не представляє всю тематику.', en: 'The conclusion is limited to selected articles; one general article does not represent the entire subject.', ru: 'Вывод ограничен выбранными статьями; одна общая статья не представляет всю тематику.' }[locale])}</p>${analysis.knownIssues?.map(i => `<p class="note"><a href="${h(i.source)}">Wikimedia ${h(i.period.start)} - ${h(i.period.end)}</a>: ${h(i.note)}</p>`).join('') ?? ''}</section>
${sourceTable(analysis, locale, 'used')}
<div class="charts">${chartMode !== 'relative' ? `<figure class="chart">${charts.absolute}</figure>` : ''}${chartMode !== 'absolute' ? `<figure class="chart">${charts.relative}</figure>` : ''}</div>${extraChart ? `<p class="note">${h(extraChart)}</p>` : ''}
${entries.some(e => e.metrics.monthly.some(m => !m.fullMonth)) ? `<p class="note">${h(t.partialMonths)}</p>` : ''}
<section><h2>${h(t.metrics)}</h2><table><thead><tr><th>${h(t.row)}</th><th>${h(t.views)}</th><th>${h(t.daily)}</th><th>${h(t.annual)}</th><th>${h(t.share)}</th></tr></thead><tbody>${rows}</tbody></table><p class="note">${h(t.precision)}</p></section>
<section><h2>${h(t.quality)}</h2><p>${h(statuses)}.</p><p class="note">${h(reasonsShown)}${reasons.length > 3 ? ` (+${reasons.length - 3}: analysis.json)` : ''} ${h(topicWarnings)} ${h(t.limits)}</p></section>
${sourceTable(analysis, locale, 'audit')}<section><h2>${h(t.validation)}</h2><p>${h(t.hypothesis)}</p></section>
<footer><strong>${h(t.sources)}</strong><p><a href="https://www.wikidata.org/wiki/Wikidata:Data_access">Wikidata</a> · <a href="https://www.mediawiki.org/wiki/API:Query">MediaWiki</a> · <a href="https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html">Wikimedia Analytics API</a>. ${h(t.downloaded)}: ${h(retrieval)}. ${h(t.full)}</p><p>runId: ${h(analysis.runId)} · diagnostic ${h(analysis.diagnosticVersion)} · ${h(locale)}</p></footer>
</main></body></html>` };
}
