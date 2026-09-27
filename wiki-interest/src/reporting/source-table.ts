import type { Analysis } from '../analysis.js';
import { escapeHtml as h, type Locale } from './locale.js';

const labels = {
  uk: { heading: 'Перевірені статті', lang: 'Мова', article: 'Стаття та Wikidata', match: 'Відповідність', decision: 'Рішення й причина', used: 'Використана', rejected: 'Відхилена', pending: 'Зміст ще не перевірено', audit: 'Перевірка недоступних відповідників', search: 'Пошук', bounded: 'Точного відповідника не знайдено серед перевірених кандидатів', more: 'Інші перевірені кандидати', archive: 'Повні причини, знімки, час і точні API-запити: source-manifest.json → pageviewRequests / analysis.json → articleSources. Каталог інших мов — source-catalog.json; знайдене посилання не означає аналізу.', legacy: 'У старому run URL не збережені. Виконайте sources; не складайте посилання вручну.' },
  en: { heading: 'Verified articles', lang: 'Language', article: 'Article and Wikidata', match: 'Match', decision: 'Decision and reason', used: 'Used', rejected: 'Rejected', pending: 'Content review pending', audit: 'Unavailable equivalents audit', search: 'Search', bounded: 'No exact equivalent found among checked candidates', more: 'Other checked candidates', archive: 'Full reasons, snapshots, timestamps and API requests: source-manifest.json → pageviewRequests / analysis.json → articleSources. Other languages: source-catalog.json; discovered links do not imply analysis.', legacy: 'This legacy run has no saved article URLs. Run sources; do not invent links.' },
  ru: { heading: 'Проверенные статьи', lang: 'Язык', article: 'Статья и Wikidata', match: 'Соответствие', decision: 'Решение и причина', used: 'Использована', rejected: 'Отклонена', pending: 'Содержание ещё не проверено', audit: 'Проверка недоступных соответствий', search: 'Поиск', bounded: 'Точное соответствие не найдено среди проверенных кандидатов', more: 'Другие проверенные кандидаты', archive: 'Полные причины, снимки, время и API-запросы: source-manifest.json → pageviewRequests / analysis.json → articleSources. Другие языки: source-catalog.json; найденные ссылки не означают анализ.', legacy: 'В старом run нет URL. Выполните sources; не составляйте ссылки вручную.' },
};
export function sourceTable(a: Analysis, locale: Locale, mode: 'used' | 'audit'): string {
  const t = labels[locale], sources = a.articleSources;
  if (!sources?.pages.length) return `<p class="note">${h(t.legacy)}</p>`;
  const used = new Set(sources.pages.map(s => s.sourceId));
  const unavailable = sources.mappings.filter(m => !sources.pages.some(p => p.language === m.language && p.expectedQid === m.qid));
  const rejected = [...new Map(unavailable.flatMap(m => m.candidates.slice(0, 2)).map(s => [s.sourceId, s])).values()];
  const rows = mode === 'used' ? sources.pages : rejected;
  // Large reviewed baskets share decisions; group them without dropping any source links.
  if (mode === 'used' && rows.length > 8 && rows.every(s => s.semantic.status === 'reviewed' && s.semantic.matchType === 'exact')) {
    const groups = new Map<string, typeof rows>();
    for (const source of rows) {
      const key = JSON.stringify([source.language, source.qidStatus, source.semantic.rationale]);
      const group = groups.get(key) ?? [];
      group.push(source); groups.set(key, group);
    }
    const grouped = [...groups.values()].map(group => {
      const first = group[0]!;
      const links = group.map(s => {
        const request = sources.requests.find(r => r.sourceId === s.sourceId);
        return `<span data-source-id="${h(s.sourceId)}"><a href="${h(s.articleUrl)}">${h(s.title)}</a>${s.wikidataUrl ? ` · <a href="${h(s.wikidataUrl)}">${h(s.wikidataId!)}</a>` : ''}${request ? ` · <a href="${h(request.requestUrl)}">API</a>` : ''}</span>`;
      }).join('; ');
      return `<tr><td>${h(first.language)}</td><td>${links}</td><td>exact<br>${h(first.qidStatus)}</td><td>${h(t.used)}. ${h(first.semantic.rationale)}</td></tr>`;
    }).join('');
    const groupedNote = locale === 'uk' ? 'Джерела згруповано за мовою та однаковим рішенням; усі посилання збережено. Source IDs і повні докази — в analysis.json.' : locale === 'ru' ? 'Источники сгруппированы по языку и одинаковому решению; все ссылки сохранены. Source IDs и полные доказательства — в analysis.json.' : 'Sources are grouped by language and identical review decision; all links are retained. Source IDs and full evidence are in analysis.json.';
    return `<h2>${h(t.heading)}</h2><table class="source-table"><thead><tr><th>${h(t.lang)}</th><th>${h(t.article)}</th><th>${h(t.match)}</th><th>${h(t.decision)}</th></tr></thead><tbody>${grouped}</tbody></table><p class="note">${h(groupedNote)}</p>`;
  }
  const table = rows.length ? `<table class="source-table"><thead><tr><th>${h(t.lang)}</th><th>${h(t.article)}</th><th>${h(t.match)}</th><th>${h(t.decision)}</th></tr></thead><tbody>${rows.map(s => {
    const request = sources.requests.find(r => r.sourceId === s.sourceId);
    return `<tr data-source-id="${h(s.sourceId)}"><td>${h(s.language)}</td><td><a href="${h(s.articleUrl)}">${h(s.title)}</a>${s.wikidataUrl ? `<br><a href="${h(s.wikidataUrl)}">${h(s.wikidataId!)}</a>` : ''}${s.semantic.sectionUrl ? `<br><a href="${h(s.semantic.sectionUrl)}">section_only</a>` : ''}<br><span class="note">${h(s.sourceId)}</span>${request ? `<br><a href="${h(request.requestUrl)}">Pageviews · ${h(request.granularity)}</a>` : ''}</td><td>${h(s.semantic.matchType)}<br>${h(s.qidStatus)}${s.semantic.status === 'pending' ? `<br>${h(t.pending)}` : ''}</td><td>${h(used.has(s.sourceId) ? t.used : t.rejected)}. ${h(s.semantic.rationale.length > 200 ? s.semantic.rationale.slice(0, 199) + '… (analysis.json)' : s.semantic.rationale)}</td></tr>`;
  }).join('')}</tbody></table>` : '';
  if (mode === 'used') return `<style>table.source-table{font-size:10px}table.source-table th:first-child,table.source-table td:first-child{width:7%;text-align:left}table.source-table th:nth-child(2){width:35%}table.source-table th:nth-child(3){width:18%}table.source-table th:nth-child(4){width:40%}table.source-table td{padding:3px;text-align:left}.source-table .note{font-size:8.5px;white-space:nowrap}</style><h2>${h(t.heading)}</h2>${table}`;
  return `<h2>${h(t.audit)}</h2>${unavailable.map(m => `<p class="note"><strong>${h(m.language)} / ${h(m.qid)}: ${h(m.status)}</strong>. sitelink: ${m.sitelinkPresent}; searchCompleted: ${m.searchCompleted}; truncated: ${m.searchTruncated}; ${h(m.checkedAt)}. ${m.status === 'not_found_after_search' ? h(t.bounded) : ''}<br>${m.queries.map(q => `<a href="${h(q.searchUrl)}">${h(t.search)}: ${h(q.query)}</a> (${q.checked}/${q.returned})`).join('; ')} ${h(m.errors.map(e => `${e.code}: ${e.message}`).join('; '))}${m.candidates.length > 2 ? `<br>${h(t.more)}: ${m.candidates.slice(2).map(s => `<a href="${h(s.articleUrl)}">${h(s.title)}</a> (${h(s.qidStatus)}; ${h(s.wikidataId ?? '—')})`).join('; ')}` : ''}</p>`).join('')}${table}<p class="note">${h(t.archive)}</p>`;
}
