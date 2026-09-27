# Контракти: ядро 1.0.0, методологія / аналіз / звіт 3.0.0

Розширення джерел: [review / sources та sourceIds](sources.md). `analyze.sourceResolutionIds` підтримує перевірені рішення й у topic; усі нові поля артефактів опціональні для читання старих run. `report` templateVersion 5.0.0 перевіряє HTTPS href через PDF Link annotations і зберігає link-verification.json. `sources` приймає --run і JSON `{mode: "refresh" | "historical", resolutionId?: UUID}`, не отримує Pageviews, створює новий runId. `review` приймає тільки --input і створює новий resolutionId. Чисел метрик ці операції не приймають.

Додано `research`, `resolve.articleUrl` та необов’язковий `analyze.recoverGaps`. [Контракт завершення і відновлення](completion.md) описує вкладений analysis, мовну політику, executionStatus/requestCompletion/metricQuality, контрольні точки та методи розрахунків. Research приймає до 10 запитаних мов; analyze/resolve допускають до 12 для двох доповнень. Поля старих run не мігрують; розширення completion/recovery опціональні. Новий report templateVersion — 4.0.0; старі версії залишаються читабельними.

## Topic-операції 3.0.0

Авторитетні strict-схеми: `src/topic-plan.ts`, `src/schemas.ts`, `src/reporting/report.ts`. Старі run зі schemaVersion 1.0.0, analysis 2.0.0 і старі report читаються без міграції на місці. Нові run мають methodologyVersion 3.0.0; старі припущення не переписуються. Поле mode відсутнє у старому analyze-вході для сумісності; для нового дослідження агент явно задає article/topic.

### discover

Обов’язкові `query`, `languages` (1–10). `queryLanguage` типово uk; `seedQids` і `pageTitles` до 30; `searchTerms` до 8; `linkTitles` / `categoryTitles` до 5. Limits: candidates типово40/максимум80, depth1/максимум2, requests160/максимум400. Це бюджет логічних унікальних викликів шлюзу (включно з cache hits), кожен мережевий виклик має до 3 HTTP-спроб. Джерела live/offline/fixtures, fixtureId demo-v1 і cachePolicy reuse/refresh мають попередню семантику.

Wikidata search пагінується через search-continue; MediaWiki search/links/categorymembers — через повернені continuation. Порожня сторінка з continue не означає кінець. Category BFS має обмежену глибину; namespace0 дає статті, namespace14 — лише дочірні категорії. Ліміти/помилки/незавершена pagination відображаються в discoveryTruncated/truncationReasons. Перегляди не завантажуються. Повторні QID/канонічні сторінки об’єднують provenance, а не збільшують список.

Незмінний `runtime/discoveries/<discoveryId>.json`: schema3, candidates (candidateId, QID або null, label, description, aliases, sources з snapshotIds, verified articles, subtopic, proposed/selected/excluded, reason), snapshots, request, logicalRequests, metadataBasis. Summary показує максимум12 кандидатів і шлях до повного файлу.

### plan

Вхід: discoveryId, необов’язковий parentPlanId, basketId (slug), label, question, productContext, boundaries; subtopics (1–8, id/label/rationale); decisions (candidateId, selected/excluded, reason, role root/core/extended, subtopic); period; filters типово all-access/user; assumptions та limitations (непорожні масиви). Мови успадковуються із discovery. Кожна selected концепція потребує перевіреного QID і принаймні однієї знайденої статті; невстановлені QID збережені лише як кандидати. Потрібен core, максимум одна root, усього до30 концепцій. Некоректні посилання, дубльовані рішення й підтематики відхиляються. У невибраних кандидатів зберігається явна стандартна причина виключення.

Результат `runtime/plans/<topicPlanId>.json`: topic-plan зі складом, decisions, discovery, frozenAt, SHA-256 compositionVersion, правилами порівняння та версією методології. Це не автоматичне підтвердження релевантності; відповідальність за зміст лишається в агента.

### analyze у двох режимах

Article: `{ "mode":"article", "topics":[{"topicId":"chemistry","label":"Хімія","concepts":[{"qid":"Q2329"}]}], "languages":["uk"] }`. Явний article дозволяє одну унікальну концепцію на topic. Старий вхід без mode зберігає сумісність із попередніми наборами.

Topic: `{ "mode":"topic", "topicPlanId":"UUID отриманого плану", "languages":["uk"] }` (замініть пояснювальний UUID фактичним). Topics не передаються. Дати/фільтри/мови мають збігатися з планом; пропущені дати й фільтри успадковуються. Для demo явно передайте source: fixtures, fixtureId: demo-v1. Код одним запуском завантажує всі потрібні статті та спільний знаменник, обчислює root/core/extended/subtopic/concept і зберігає coverage матрицю.

Нові артефакти run: discovery.json, topic-plan.json, coverage.json, contributions.json, sensitivity.json. Їх SHA-256 збережено в artifactChecksums і перевіряється readRun/inspect. Повні дані також у analysis.topicStudy, власні копії у звіті. Findings/evidence додають scope, basketId, compositionVersion, coveragePercent, quality flags та sensitivityScenarioIds. Summary topic містить головні висновки, порівняння й чотири виміри якості; денних рядів не містить.

### Зміна плану та повторне використання

`revise --run` приймає `changes.topicPlanId`; успадковує мови/дати/фільтри нового плану. Новий run має parentRunId; старий не змінюється. Для нової мови створіть discovery/plan з повним списком мов (cache reuse), потім revise. Для піднабору достатньо нового plan із того самого discovery. Наявні snapshot refs батька мають пріоритет перед кешем при reuse; відсутні блоки завантажуються. Проєктний знаменник спільний і не множиться на кількість статей. Criterion / порожні changes перераховують analysis без API; report locale без API. Refresh і нове джерело не примушуються до старих snapshots.

Нові коди: DISCOVERY_LIMIT, PLAN_DUPLICATE, PLAN_UNVERIFIED, PLAN_SUBTOPIC, PLAN_COMPOSITION, PLAN_MISMATCH. Обрізаний discovery успішно повертає needs_selection з DISCOVERY_TRUNCATED, а не вигаданий повний список.

## Сумісне ядро та report

Нові run містять `analysis.json` (3.0.0: політика, findings/evidence/sources, покриття, показники, діагностика й сценарій) і `series.csv`. Manifest ядра лишається 1.0.0 із необов’язковими `analysisChecksum`, `diagnosticVersion`, `diagnostics`; inspect перевіряє checksum analysis. Старі run читаються без змін: report обчислює analysis у своїй новій директорії, не змінюючи run першого етапу.

### report

CLI потребує `--run`; `--input` необов’язковий. Схема — `src/reporting/report.ts`. Strict-вхід: `locale?: uk|en|ru` (типово uk), `rowIds?: string[]` (1–4 наявних), `findingIds?: string[]` (1–3 наявних), `replayReportId?: UUID`. ID не повторюються. Довільні метрики, HTML, URL, промпти чи код не приймаються. Якщо задано rowIds, findings повинні стосуватися тільки цих рядків; інакше рядки вибраних findings входять першими. Типово 4 рядки впорядковуються за критерієм; 2 findings цього критерію беруться серед них у стабільному порядку аналізу.

`replayReportId` забороняє інші поля й відтворює представлення конкретного звіту за його власними даними, HTML, SVG і сирими знімками. Потрібні збережені версії бібліотек рендерингу. Run і кеш не читаються. Новий reportId має parentReportId. PDF може мати іншу службову дату, тому бінарна ідентичність PDF не обіцяється. Дані, HTML і SVG лишаються ідентичними.

Операція не звертається до API. Chromium працює offline, з вимкненим JavaScript, заблокованими service workers, route abort і CSP. Зовнішній текст екранується; локальні шрифти вбудовані. Перед PDF перевіряються геометрія й шрифти; PDF.js перевіряє 1–3 сторінки A4, розділи та числові рядки, Canvas рендерить кожну сторінку PDF у PNG. Topic має власний шаблон на 2–3 сторінки, який не підпорядковує висновок критерію сортування. Якщо два графіки не вміщуються, короткий варіант містить один відповідно до критерію і повідомлення про другий SVG. Подальше переповнення — помилка з HTML, без обрізання чи приховування сторінок.

Коди: `FINDING_NOT_FOUND`, `FINDING_OUTSIDE_SELECTION`, `REPORT_ROW_NOT_FOUND`, `REPORT_ID_MISMATCH`, `RENDERER_VERSION_MISMATCH`, `BROWSER_UNAVAILABLE`, `FONT_UNAVAILABLE`, `REPORT_OVERFLOW`, `PDF_PAGE_COUNT`, `PDF_NOT_A4`, `PDF_CONTENT_MISMATCH`. Матеріали помилки залишаються в директорії з `error.details.artifactsDirectory`; `failure.json` фіксує причину. Manifest успішного звіту записується останнім. Кожен файл, включно з PDF, записується атомарно.

Manifest звіту 3.0.0 у `runtime/reports/<runId>/<reportId>/manifest.json`: schema/template versions, runId/reportId/parentReportId, час, locale/rowIds/findingIds, chartMode, версії renderer, SHA-256, списки скорочень та verification. `source-manifest.json` — копія manifest дослідження. Власні snapshots звіту перевіряються FileStore. `report-page-N.png` для всіх сторінок і `report-preview.png` для першої отримуються з PDF.js, `report-text.txt` — із текстового шару PDF. Автоматичний `visualReview: pending` не стверджує, що людина чи агент оглянули PNG.

Авторитетні схеми — `src/schemas.ts`, `src/models.ts`, `src/requests.ts`. Вхідні об’єкти strict: невідомі поля відхиляються. Зовнішні відповіді допускають додаткові поля API, але потрібні поля перевіряються Zod. Дати — реальні `YYYY-MM-DD`, QID — `Q` та додатне ціле; resolutionId/runId — UUID. Мови — коди мовних проєктів Wikipedia, не довільні домени або locales на кшталт країни.

## Операції

Реєстр `operations` містить `name`, `inputSchema`, `outputSchema`, `runRequired`, `execute`. `executeOperation(name, input, services, runId?)` перевіряє вхід та вихід і повертає єдиний envelope. Codex або Claude Code керує ним через scripts/cli.ts; власного AI-runner немає й не потрібно. Залежності `Services`: `store`, `clock`, `transport`, `fixtureTransport`, `log`. Чисті розрахунки мережі не потребують.

### resolve

Обов’язкові: рівно одне з `query`/`qid`, `queryLanguage`, `languages`. Необов’язкові: `source`, `fixtureId`, `cachePolicy`. Пошук повертає до п’яти кандидатів і `needs_selection`, навіть якщо кандидат один. Явний QID перевіряється без текстового пошуку. Кандидат містить `qid`, `requestedQid`, `label`, `description`, `labelLanguage`, revisionId за наявності, статті та попередження. Назви й описи залишаються такими, як їх повернув Wikidata; відсутній переклад не вигадується.

### analyze

Обов’язкові: `topics`, `languages`.

```json
{
  "topics": [{ "topicId": "astronomy", "label": "Астрономія", "concepts": [{ "qid": "Q333" }] }],
  "languages": ["uk", "pl"],
  "queryLanguage": "uk",
  "period": { "start": "2021-01-01", "end": "2022-12-31" },
  "filters": { "access": "all-access", "agent": "user" },
  "criterion": "views",
  "source": "live",
  "cachePolicy": "reuse"
}
```

Концепція може додатково містити `resolutionId`; QID мусить бути серед його кандидатів. Різні походження fixtures/live не можна змішувати через resolution. `topicId` унікальний; `languages` не повторюються. Для сумісного входу без mode максимум: 5 тем × 30 концепцій, 10 мов; новий topic має до30 концепцій загалом. Якщо period не задано, в manifest зберігаються обчислені точні дати.

### inspect

CLI потребує `--run`; `--input` необов’язковий. Вхід `{ "verifySnapshots": true }`, типово true. `false` пропускає перевірку сирих знімків, але структура run і checksum збережених рядів перевіряються завжди. Мережа не використовується.

Сумісне розширення: `view: summary|findings` (типово summary), `offset` (ціле >=0, типово 0), `limit` (1–14, типово 7). `view: findings` повертає сторінку збережених findings у summary: findings, total, offset, nextOffset (null наприкінці), короткі evidence, limitations/hypotheses. Кожне evidence містить до трьох sourceIds і повну sourceCount; всі sourceIds та джерела доступні в analysis.json. Денних рядів тут немає. Старі run без analysis отримують це представлення у пам’яті, без зміни run. Offset/limit стосуються лише findings.

### revise

CLI потребує `--run` і `--input`. Вхід: `mode: revise|replay` (типово revise), `changes` (типово `{}`), необов’язковий `source`, `cachePolicy: reuse|refresh`. Поля changes: `topics`, `languages`, `queryLanguage`, `period`, `filters`, `criterion`. Передане поле замінює попереднє цілком; масиви не об’єднуються. Невказані поля успадковуються.

Зміна лише criterion або порожні changes без оновлення використовують дані батьківського run без мережі. Інші зміни повторно перевіряють потрібні відповідності через кеш/джерело та завантажують відсутні блоки. `mode: replay` забороняє changes, source і refresh, відтворює лише знімки батьківського run. Читання старих версій збережено; replay створює новий результат за поточною методологією, не переписуючи старий. Replay report використовує оригінальні HTML/SVG і перевірений текст старого PDF.

## Джерела та кеш

| Параметри | Поведінка |
|---|---|
| `source: live`, `cachePolicy: reuse` | Незмінні знімки з кешу; мережа лише за відсутності блоку. |
| `cachePolicy: refresh` | Нові відповіді метаданих і рядів, нові посилання кешу; старі знімки зберігаються. |
| `source: offline` | Лише namespace кешу Wikimedia; немає мережі, fixture fallback або refresh. |
| `source: fixtures`, `fixtureId: demo-v1` | Синтетичний provider і окремий namespace кешу. |
| `mode: replay` | Тільки посилання на знімки конкретного батьківського run, а не поточний кеш. |

Метадані кешуються за параметрами операції. Ряди — за видом endpoint, проєктом, точним заголовком для статті, фільтрами і місячним блоком. Денна granularity фіксована контрактом. Кешований блок, який повністю покриває новий запит, використовується з фільтрацією потрібних дат. Якщо частковий блок недостатній, завантажується потрібна частина цього місяця; інші місяці не перезавантажуються. TTL немає — оновлення лише явне. Одночасні процеси можуть повторно завантажити той самий блок; атомарний запис запобігає частково записаному JSON.

## Артефакти

`manifest.json`: версії, runId, parentRunId за наявності, час створення, режим і походження, початковий запит, розгорнутий запит, кандидати й статті, coverage, місячні ряди та показники, попередження, список SnapshotRef, checksum series.json, лічильники використання даних.

`series.json`: точний період, денні ряди статей і проєктів, діагностика кожного ряду та денні агрегати тем. Невідоме значення — JSON `null`.

Snapshot містить початкове тіло API як рядок, точний запит, URL джерела, receivedAt, origin та schemaVersion. snapshotId і checksum — SHA-256 канонічного JSON знімка разом із кінцевим LF. SnapshotRef містить URL, час отримання, походження та checksum. Fixture snapshots мають реальний формат URL endpoint для простежуваності контракту, але `origin: fixtures`: цей URL **не означає**, що був живий запит. Метадані receivedAt означають час отримання від provider, не час публікації Wikimedia.

## Результати та помилки

`status`: `ok`, `partial`, `needs_selection`, `error`. Частковий run зберігається за прогалин або неповного покриття. Недостатня історія для окремої метрики сама по собі не є пошкодженням даних: метрика містить reason, а run може мати `ok`.

`summary` містить походження `source` (wikimedia/fixtures), режим `dataMode` (live/offline/fixtures/replay), період, критерій, перші 10 впорядкованих рядків порівняння, загальну comparisonCount, якість і coverage; великих денних рядів там немає. stdout показує до 20 попереджень плюс повідомлення про скорочення; повні списки — у manifest. `dataAccess` описує створення run, а не мережеві дії inspect. `nextAction` — підказка, не автоматичний виклик. Короткі журнали створення resolution/run зберігаються окремо в runtime/logs; inspect файлових записів не створює.

Стабільні приклади кодів: `VALIDATION_ERROR`, `INVALID_JSON`, `INPUT_READ_ERROR`, `USER_AGENT_REQUIRED`, `QID_NOT_FOUND`, `CANDIDATE_NOT_FOUND`, `PERIOD_UNAVAILABLE`, `DATA_NOT_FOUND`, `HTTP_TIMEOUT`, `RATE_LIMITED`, `NETWORK_ERROR`, `API_ERROR`, `OFFLINE_CACHE_MISS`, `FIXTURE_MISS`, `REPLAY_DATA_MISSING`, `CHECKSUM_MISMATCH`, `UNSAFE_PATH`. Помилки CLI повертають exit code 1. Сирі англомовні подробиці Zod/API можуть залишатися у details; основне message українське.

## Середовище й окремі перевірки

Відносний --input прив’язаний до фізичного кореня навички, абсолютний шлях незмінний. Runtime і локальні ресурси також від коду, не cwd. Node EACCES/EPERM/EROFS/ENOSPC поза спеціальними обробниками мають code `STORAGE_UNAVAILABLE`; обмеження доступу до вхідного JSON — `INPUT_READ_ERROR`.

`npm run doctor` — окремий легкий TypeScript-скрипт без tsx/Zod, придатний до npm ci на Node 24. Summary містить checks зі статусами passed/warning/blocked, offlineReady/liveReady. Коди NODE_UNSUPPORTED, DEPENDENCY_MISSING, PACKAGE_INVALID, BROWSER_UNAVAILABLE, USER_AGENT_INVALID, USER_AGENT_CONTACT_MISSING, WRITE_UNAVAILABLE. Він перевіряє наявність ресурсів, не запуск Chromium/мережу; лише створює й видаляє тимчасовий запис у runtime.

Єдине джерело ідентифікації — `resolveWikimediaIdentity` у environment.ts: явний WIKIMEDIA_USER_AGENT → наявний HttpOptions.userAgent → package.json name/version та контакт (bugs.url, author.url, homepage, repository.url, погоджений author.email). ENV необов’язковий. Явне порожнє або некоректне значення відхиляється, не маскується fallback. Без придатних метаданих live повертає USER_AGENT_CONTACT_MISSING; некоректне перевизначення — USER_AGENT_INVALID. Doctor розрізняє OPTIONAL_ENV_NOT_SET (passed) та непридатну підсумкову ідентифікацію, показує wikimediaIdentity.source/detail/valid без значення контакту. Offline/fixtures/report не звертаються до конфігурації HTTP.

`npm run smoke:live` — окремий сценарій перевірки, не нова аналітична операція. Його JSON має status passed/failed/blocked, smokeId, runId або null, logicalRequests, report/reuse/error, artifact і retryCommand. Протокол незмінний у runtime/smoke. Вибір Q333 має пройти живий пошук із перевіркою назви astronomy, опису про celestial/cosmos і української статті. Зміна семантики дає SMOKE_SELECTION_CHANGED; неповні ряди — SMOKE_INCOMPLETE_DATA. HTTP-передумови й конфігураційні помилки позначаються blocked. Live ніколи не підміняється fixtures.


`npm run smoke:live` тепер запускає article-сценарій та `smoke:topic`. Тематичний smoke: заздалегідь задані 12 навчальних українських статей + контрольна Хімія; усі перевіряються через живі Wikidata/MediaWiki, план фіксується до AQS. Budget до850 логічних запитів (до3 HTTP-спроб кожен); discovery до200. Без очікуваного знаку динаміки. Немає контактного UA / доступу / повноти → blocked із конкретною причиною, без fixtures. Повний локальний synthetic pipeline — окрема команда demo:topic.
