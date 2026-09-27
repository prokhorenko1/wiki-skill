# Перевірені джерела API

## Докази відповідників: 27.09.2026

У цій ітерації через вебінструмент відкриті всі задані офіційні сторінки: [Help:Sitelinks](https://www.wikidata.org/wiki/Help:Sitelinks), [Wikibase/API](https://www.mediawiki.org/wiki/Wikibase/API), [Pageprops](https://www.mediawiki.org/wiki/API:Pageprops), [Info](https://www.mediawiki.org/wiki/API:Info), [Langlinks](https://www.mediawiki.org/wiki/API:Langlinks), [Search](https://www.mediawiki.org/wiki/API:Search). Додатково прочитані [Revisions](https://www.mediawiki.org/wiki/API:Revisions) та [Parsing wikitext](https://www.mediawiki.org/wiki/API:Parsing_wikitext) для змісту поточної версії й реальних section anchors.

Розширення: wbgetentities `props=info|labels|descriptions|aliases|sitelinks|sitelinks/urls`, без sitefilter; page details `prop=info|pageprops|revisions&inprop=url&ppprop=wikibase_item|disambiguation&rvprop=ids|timestamp|content&rvslots=main&rvdir=older&rvlimit=1`. rvcontinue історії не обходиться, бо потрібна одна остання версія; це не continuation мов. Відсутнє запитане поле sitelinks — помилка SITELINKS_NOT_RETURNED, не доказ missing. Langlinks: llprop=url, lllimit=500, continuation за бюджетом; search: srlimit=20, srnamespace=0, continuation за бюджетом. Section anchors — parse за конкретним oldid, а не вгадані переклади.

Живий Node CLI для Q1070684 de/pl/uk/en фактично спробувано, **blocked до HTTP: USER_AGENT_CONTACT_MISSING**. Поточний процес не має ENV override, пакет не має публічного контакту. Контакти, клієнт і ліміти не змінювалися. API URL через вебінструмент також повернув Cache miss. Окремо прочитані офіційні вебсторінки статей; це не успішний API-smoke. Історичні знімки run від 27.09.2026 доступні та мають контрольні суми.

## Автоматичне завершення: 27.09.2026

Перед змінами відкрито [Wikibase/API](https://www.mediawiki.org/wiki/Wikibase/API), [API:Langlinks](https://www.mediawiki.org/wiki/API:Langlinks), [API:Search](https://www.mediawiki.org/wiki/API:Search), [page views](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html), [troubleshooting](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/troubleshooting.html). Перші три та troubleshooting доступні текстом. Reference показала заголовки, але динамічні endpoint-картки не відобразилися ані текстовим інструментом, ані в браузері; це конкретне обмеження перевірки, не підтвердження live API.

Monthly aggregate підтверджено в офіційних [прикладах проєктних метрик](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/examples/project-metrics.html), per-article monthly — в [оголошенні команди Wikimedia Analytics](https://lists.wikimedia.org/hyperkitty/list/analytics%40lists.wikimedia.org/thread/GOMJ23T3YIU5Z6GUB6IADATRHVFTUP7S/). Формат відповіді перевіряє Zod; fixtures не є доказом живого контракту. Troubleshooting прямо описує неоднозначність missing records/404: нуль або ще не завантажене значення, та затримки публікації. Langlinks прочитано, але автоматичне підтвердження тут спирається на Wikidata/sitelinks і wikibase_item, а не саму наявність мовного посилання.


## Тематичне розширення: перевірено 27.09.2026 до реалізації

| Офіційне джерело | Перевірений контракт / обмеження |
|---|---|
| [API:Search](https://www.mediawiki.org/wiki/API:Search) | action=query, list=search, srsearch, srnamespace=0, srlimit; continuation sroffset та continue. |
| [API:Categorymembers](https://www.mediawiki.org/wiki/API:Categorymembers) | list=categorymembers, cmtitle, cmtype=page/subcat, cmlimit; cmcontinue. Обмежений BFS, категорія не доказ релевантності. |
| [API:Links](https://www.mediawiki.org/wiki/API:Links) | prop=links, titles, plnamespace=0, pllimit; plcontinue. Пагінація обробляється навіть після порожньої порції. |
| [Wikidata:Data access](https://www.wikidata.org/wiki/Wikidata:Data_access) | Пошук сутностей і структуровані entity дані; labels/descriptions/aliases не є метриками інтересу. |
| [Help:Sitelinks](https://www.wikidata.org/wiki/Help:Sitelinks) | Відповідність концепції сторінкам різних wiki через site ID. Заголовки не перекладаються вручну. |
| [API:Revisions](https://www.mediawiki.org/wiki/API:Revisions) | rvdir=newer, rvlimit=1, rvprop=timestamp для найстарішої видимої revision однієї сторінки. Це індикатор доступної історії, не гарантія відсутності імпорту/видалення. |
| [Page views reference](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html) | Відкрито; динамічні endpoint-картки текстовий snapshot не показав. Шляхи додатково звірено з офіційними [page examples](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/examples/page-metrics.html) і [project examples](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/examples/project-metrics.html). Не заявляємо нове виконання AQS лише з читання документації. |
| [Troubleshooting](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/troubleshooting.html) | 404 та прогалини можуть означати нуль або ще не завантажені дані. Null + unknown_not_zero зберігає неоднозначність, не приписує доведену втрату. |
| [Access policy](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html) | Описовий UA з контактом, послідовні запити та обмежені повтори; live smoke вимагає явне коректне перевизначення. |

API-help wbgetentities у цій перевірці повернула помилку доступу; її повторне живе виконання не підтверджено. Зміни entity props aliases та revisions додатково перевіряються контрактними fixtures, які не є доказом доступності живого API. Код зберігає фактичні raw responses/URL/час/checksum, не вигадує результати.

Переглянуто [офіційний індекс Data Issues](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues) і релевантні для 2024-09–2026-08 повідомлення:

- [Втрата webrequest 2024](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2024-10-10_Webrequest_Data_Loss_-_Clobbered_Hadoop_Temporary_Dir): залишкова часткова втрата історії 2023-05-11–2024-09-09; закриття інциденту не означає повне відновлення всіх старих pageviews.
- [Класифікація трафіку 2024](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2024-09-20_Unique_Devices_by_Family_Inflated_Due_to_Miscategorized_Traffic): у змішаному повідомленні окремий вплив на pageviews переважно вересень–жовтень, частково серпень–листопад. Виправлення 04.12.2024. Частина про redirects впливає на unique devices, а не pageviews; backfill unique devices не приписано pageviews.
- [Bot traffic травня 2025](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2025-06-03_May_2025_spike_in_bot_traffic): класифікація оновлена 28.08.2025; backfill pageviews від 20.03 завершено 08.10.2025. Знімки після backfill можуть уже містити корекцію.
- [Haproxy/Kafka 2025](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2025-06-30_Haproxykafka_silently_stopped_sending_request_data_to_Kafka): втрата запитів двох серверів у підінтервалах травня–липня; консервативна об’єднана межа 11.05–23.07.2025. Закрито 22.08; глобальні оцінки не є коефіцієнтами для статей.
- [Bot traffic листопада 2025](https://wikitech.wikimedia.org/wiki/Data_Platform/Data_Lake/Data_Issues/2026-06-10_Nov_2025_spike_in_bot_traffic): класифікація виправлена 04.04.2026; backfill із 01.12.2025 завершено 15.05.2026; листопад відновити не вдалося. Дати перетинаються зі старим run, але вплив саме на Хімію не доведено.

Реєстр зберігає джерело/період/статус/reviewedAt і backfillCompleted або null. Він не названий вичерпним. Глобальні оцінки ботів/втрат не множаться на конкретні статті. Незалежні API-порівняння і живий chemistry smoke в цій сесії blocked через відсутність контактного WIKIMEDIA_USER_AGENT; доступність вебдокументації не замінює ці перевірки.

## Історичні записи попередніх етапів

Нижче збережено попередню історію перевірок; вона не є заявою про нове виконання у тематичному етапі.


Додаткове уточнення 2026-09-27 перед додаванням дефолту User-Agent: повторно відкрито [Access policy](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html) та [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). Вони просять описову ідентифікацію та спосіб зв’язку. Дефолт wiki-interest/0.1.0 є назвою/версією власного клієнта, але не містить контакту й не заявляється як повна відповідність політиці; doctor видає попередження. Технічна відповідь maxlag на живу спробу не є гарантією подальшого доступу або підтвердженням політики.

## Підключення до рідних агентів: 2026-09-27

Перед поточними змінами повторно перевірено офіційні джерела:

| Джерело | Фактичний результат поточної перевірки |
|---|---|
| [Agent Skills specification](https://agentskills.io/specification) | Доступна: frontmatter name/description, compatibility, обмеження довжини, відносні ресурси та компактна основна інструкція. |
| [Codex Skills](https://developers.openai.com/codex/skills/) | Отримано через офіційний документаційний інструмент: .agents/skills у проєкті та HOME, symlink, явне/неявне використання. |
| [Claude Code Skills](https://code.claude.com/docs/en/skills) | Доступна: .claude/skills у проєкті та HOME, symlink, /wiki-interest і вибір за description. |
| [Claude Code model config](https://code.claude.com/docs/en/model-config) | Доступна: --model, aliases, /status, session/user налаштування й обмеження видимості fallback. |
| [Anthropic models](https://platform.claude.com/docs/en/models/overview) | Підтверджений повний ID Haiku 4.5: claude-haiku-4-5-20251001. Доступність у конкретному акаунті не перевірена. |
| [Claude Code commands](https://code.claude.com/docs/en/commands) | Доступна: /export, /status, /usage; у поточній документації /cost — alias. Встановлена локальна версія може відрізнятися. |
| [Page views reference](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html) | Сторінка відкрилася; текстовий інструмент і поточний браузерний snapshot показали заголовки endpoint та початок даних 2015-07-01, але не повні динамічні картки контрактів. Їхній вміст цього разу повторно не підтверджено; попередній запис нижче збережено як історію, не як новий доказ. Контракти коду не змінювалися за здогадкою. |
| [Access policy](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html) | Доступна: контактний User-Agent і послідовні запити. |
| [Wikidata Q333](https://www.wikidata.org/wiki/Q333) | Жива вебсторінка підтвердила astronomy й опис науки про небесні об’єкти. Це перевірка початкового предмета smoke, не виконання Analytics API. Сценарій зобов’язаний окремо перевірити пошук, сутність і статті через API. |


## Другий етап: локальна візуалізація й PDF

Перевірено 2026-09-27 перед реалізацією:

- [ECharts: server-side rendering](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/) — сторінка доступна. `echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })`, `renderToSVGString()`, явне `animation: false`, `dispose()` після рендерингу.
- [Playwright: Page](https://playwright.dev/docs/api/class-page) — сторінка доступна. `page.pdf`, формат A4, CSS print, `preferCSSPageSize`, `setContent`, маршрутизація. Використано всі сторінки без `pageRanges`; схеми опцій додатково перевірені TypeScript встановленої версії. Мережеві запити блокуються на BrowserContext, service workers вимкнені.

Розбір і рендер PDF виконуються встановленим `pdfjs-dist` та `@napi-rs/canvas`; власного PDF-парсера немає. Точні версії бібліотек і браузера записуються в manifest кожного звіту. Шрифти Noto Sans постачаються npm-пакетом локально (ліцензія SIL Open Font License у пакеті); CDN під час рендерингу не потрібен.

Перевірено 2026-09-27 перед реалізацією. Цей запис описує перевірку документації, а не виконання живого аналітичного запиту.

| Джерело | Перевірка та використання |
|---|---|
| [Agent Skills Specification](https://agentskills.io/specification) | Доступне. SKILL.md, YAML frontmatter, name/description, відповідність назви директорії. |
| [Page view analytics reference](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html) | Сторінка доступна; текстовий інструмент не показував динамічні контракти. Endpoint-картки розкрито й перевірено у браузері. |
| [Page views concepts](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/concepts/page-views.html) | Доступне. Значення pageview, класифікація агентів, обмеження redirects. |
| [Access policy](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/documentation/access-policy.html) | Доступне. User-Agent із контактом, послідовні запити. |
| [Wikidata:Data access](https://www.wikidata.org/wiki/Wikidata:Data_access) | Доступне. Пошук, читання сутностей, правила доступу. |
| [MediaWiki API:Query](https://www.mediawiki.org/wiki/API:Query) | Доступне. normalized, redirects, missing/invalid, formatversion=2. |

Додатково перевірено [Wikibase/API](https://www.mediawiki.org/wiki/Wikibase/API), [wbgetentities](https://www.wikidata.org/w/api.php?action=help&modules=wbgetentities), [wbsearchentities](https://www.wikidata.org/w/api.php?action=help&modules=wbsearchentities) та [API:Siteinfo](https://www.mediawiki.org/wiki/API:Siteinfo). Довідку wbsearchentities текстовий інструмент не відкривав; її прочитано у браузері. Raw-файл довідки з GitLab текстовим інструментом отримати не вдалося. Shell curl до doc.wikimedia.org на етапі перевірки завершився DNS-помилкою; її не трактували як недоступність усіх джерел.

## Використані endpoint

База Analytics API: `https://wikimedia.org/api/rest_v1/metrics`.

```text
GET /pageviews/per-article/{project}/{access}/{agent}/{article}/{granularity}/{start}/{end}
GET /pageviews/aggregate/{project}/{access}/{agent}/{granularity}/{start}/{end}
```

Для обох застосовні `access: all-access|desktop|mobile-app|mobile-web`, `agent: all-agents|user|spider|automated`, `granularity: daily`. Реалізація типово використовує all-access/user. `start` та `end` включні, формат `YYYYMMDDHH`, година 00. Мінімальна дата сервісу — 2015-07-01. Відповідь: `items` із project, access, agent, granularity, timestamp, views; per-article також має article. Приклади документації повертають project без `.org`, тому обидва документовані представлення ідентичності нормалізуються для перевірки.

Wikidata: `https://www.wikidata.org/w/api.php`, `action=wbsearchentities` або `action=wbgetentities`. Пошук використовує `search`, `language`, `uselang`, `type=item`, `limit=5`. Читання — `ids`, `props=info|labels|descriptions|aliases|sitelinks`, `languages`, `redirects=yes`.

MediaWiki: `https://<validated-edition>.wikipedia.org/w/api.php`, `action=query`, `meta=siteinfo&siprop=general` для wikiid; `prop=info|pageprops|revisions&rvprop=timestamp&rvdir=newer&rvlimit=1&titles=...&redirects=1` для перевірки сторінки. JSON `formatversion=2`, `maxlag=5`. Протоколи, домени й операції конструюються кодом; API URL із user/model input не приймається.

Контрактні fixtures є синтетичними та перевіряються окремо. Вони не підтверджують поточну доступність чи точні значення живих API.

Доступність вебдокументації не доводить доступність API з Node-процесу. Поточні межі перевірки наведено в [стані реалізації](implementation-status.md).
