# Встановлення та підключення

Ціль — Codex і Claude Code з виконанням **локального коду**. У звичайному вебчаті Claude та неперевірених хмарних середовищах сумісність не обіцяється. Навичка самодостатня: спільний SKILL.md, TypeScript, lockfile, методологія й HTML/CSS-шаблон у `src/reporting/template.ts`. AGENTS.md, CLAUDE.md та ключі LLM для навички не потрібні. Власну авторизацію рідного агента налаштовує користувач окремо.

## Середовище

Почніть у директорії скопійованої навички:

```bash
export WIKI_INTEREST_ROOT="$(pwd -P)"
nvm install
nvm use
npm ci --include=dev
npm run setup:browser
npm run --silent doctor -- --offline
npm run --silent demo:offline
```

`.nvmrc` фіксує Node.js 24.21.0. Якщо nvm відсутній, встановіть Node цієї версії власним менеджером; навичка його не встановлює. `npm ci` потребує також devDependencies, зокрема tsx. Не використовуйте `--omit=dev`. Doctor виконується нативним TypeScript у Node 24 навіть до встановлення пакетів; він перевіряє локальне розміщення залежностей, наявність виконуваного Chromium, конфігурацію й тимчасовий запис у runtime. Контакти не друкує, мережу/браузер не запускає, нічого не встановлює. `--offline` не вимагає придатної конфігурації мережевої ідентифікації. Підтвердження запуску Chromium дає demo, не doctor.

На macOS `setup:browser` завантажує закріплену Playwright версію Chromium у `runtime/browser`. Для підтримуваного Playwright Linux-дистрибутива:

```bash
npm run setup:browser -- --with-deps
```

Це явне встановлення системних пакетів і браузера; можуть знадобитися права адміністратора. Linux у цьому проєкті ще **не перевірений запуском**. Під час рендерингу мережа заблокована. Noto Sans із кирилицею та розширеною латиницею надходить через lockfile, без CDN. Браузерні бінарники не передаються з навичкою.

## Конфігурація Wikimedia

Публічна копія не містить особистого контакту. Перед першим live-запитом агент має отримати від користувача справжній email або URL зі способом зв’язку, якщо конфігурації ще немає. Поясніть, що контакт передаватиметься Wikimedia у HTTP User-Agent. Наявний погоджений контакт повторно не запитуйте; не використовуйте чужу адресу або git email.

`WIKIMEDIA_USER_AGENT` містить повний заголовок із назвою, версією та контактом. [.env.example](../.env.example) показує формат у коментарі з очевидним placeholder. Замість нього користувач або агент записує **справжнє погоджене значення** у власне середовище. Placeholder і порожній рядок відхиляються до HTTP; не намагайтеся перевіряти їх live-запитом.

Для збереження між сесіями можна використати `.env.local` у корені навички: один shell-сумісний рядок `WIKIMEDIA_USER_AGENT='…'` із реальним значенням замість трикрапки. Не записуйте цей демонстраційний рядок як робочу конфігурацію. Файл ігнорує Git; зберігайте його локально, без значення контакту в документації та журналах. `.env` і `.env.local` **не завантажуються автоматично**. Якщо власний файл уже створено, у bash/zsh виконайте:

```bash
set -a
. "$WIKI_INTEREST_ROOT/.env.local"
set +a
npm --prefix "$WIKI_INTEREST_ROOT" run --silent doctor
```

Читайте через `.` лише власний довірений файл: це shell-команда. Змінна успадковується дочірніми процесами цього shell. Запускаючи агента з іншого середовища або CLI в новому shell, передайте її знову; агент може завантажити локальний файл у тому самому shell, де запускає конкретну CLI-команду. Змінювати глобальний PATH чи налаштування агента не потрібно.

Наявна функція `resolveWikimediaIdentity` має пріоритет **ENV → програмний HttpOptions.userAgent → package.json**. Для останнього варіанта потрібні name/version і перше наявне поле контакту: bugs.url, author.url, homepage, repository.url або author.email. У публічному package.json цієї навички контакту немає: fallback сам собою не робить live доступним. Не додавайте особисту адресу в публічні метадані. Майбутній реальний публічний контакт проєкту може бути налаштований автором окремо.

Doctor не надсилає HTTP і не друкує контакт. `USER_AGENT_CONTACT_MISSING` означає відсутність придатного package-контакту, `USER_AGENT_INVALID` — некоректне явне значення. `OPTIONAL_ENV_NOT_SET` саме по собі не є блокером, але без package-контакту liveReady буде false. `doctor --offline`, fixtures та PDF не потребують контакту. Перевірка синтаксису URL не доводить його належності користувачу або проєкту.

Формат відповідає [політиці Wikimedia](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). Для свідомої живої перевірки після налаштування є `npm run smoke:live`; це вже мережевий запуск, на відміну від doctor.

Дозволи: читання навички й вхідних JSON, запис у її runtime, виконання Node/Chromium; для live — HTTPS до www.wikidata.org, потрібних мовних wikipedia.org і wikimedia.org. npm registry та сервери Playwright потрібні під час встановлення. Не обходьте обмеження середовища.

## Codex та Claude Code

Розташування навичок і підтримка symlink описані в офіційній документації: [Codex Skills](https://developers.openai.com/codex/skills/), [Claude Code Skills](https://code.claude.com/docs/en/skills). Підключайте **всю директорію**, не один SKILL.md.

| Область | Codex | Claude Code |
|---|---|---|
| Один проєкт | `<project>/.agents/skills/wiki-interest/` | `<project>/.claude/skills/wiki-interest/` |
| Користувач | `~/.agents/skills/wiki-interest/` | `~/.claude/skills/wiki-interest/` |

Для розробки можна підключити symlink. Нічого нижче не виконується автоматично. Виберіть **одну** потрібну область для кожного агента, щоб уникати дубльованого імені. `PROJECT_ROOT` має бути коренем робочого проєкту **поза директорією навички**. Якщо навичка лежить безпосередньо в проєкті, з її кореня:

```bash
PROJECT_ROOT="$(cd .. && pwd -P)"
# Виберіть рівно один рядок:
SKILL_PARENT="$PROJECT_ROOT/.agents/skills"  # Codex, проєкт
# SKILL_PARENT="$HOME/.agents/skills"       # Codex, користувач
# SKILL_PARENT="$PROJECT_ROOT/.claude/skills" # Claude Code, проєкт
# SKILL_PARENT="$HOME/.claude/skills"       # Claude Code, користувач
```

Після вибору виконайте спільний захищений блок:

```bash
case "$SKILL_PARENT/" in
  "$WIKI_INTEREST_ROOT/"*) printf 'Не створюйте вкладене посилання навички на себе.\n' ;;
  *)
    TARGET="$SKILL_PARENT/wiki-interest"
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      printf 'Шлях уже існує; нічого не перезаписано: %s\n' "$TARGET"
    else
      mkdir -p "$SKILL_PARENT" && ln -s "$WIKI_INTEREST_ROOT" "$TARGET"
    fi
    ;;
esac
```

Почніть нову сесію агента у вибраному проєкті. У Codex перевірте наявність `wiki-interest` через список навичок `/skills` або вибір через `$`. Явний запит: `$wiki-interest Досліди інтерес до астрономії в українській Wikipedia та підготуй PDF`. У Claude Code відкрийте меню `/`, знайдіть `/wiki-interest` і викличте `/wiki-interest Досліди інтерес до астрономії в українській Wikipedia та підготуй PDF`.

Неявний запит для обох: «Порівняй інтерес до інтервального голодування в польській та чеській Wikipedia за останні два роки. Підготуй короткий PDF українською». Перевірте за журналом агента, що він завантажив SKILL.md і викликав CLI. Виявлення за описом залежить від моделі; його ще треба перевірити за [evaluation](evaluation.md). Якщо навичка не з’являється, перевірте весь шлях, frontmatter, доступ до symlink-цілі й почніть нову сесію. Не додавайте приховану методологію до глобальних файлів.

## Запуск з іншої директорії та результати

```bash
npm --prefix "$WIKI_INTEREST_ROOT" run --silent cli -- resolve --input examples/resolve.json
npm --prefix "$WIKI_INTEREST_ROOT" run --silent cli -- analyze --input "/path with spaces/input.json"
npm --prefix "$WIKI_INTEREST_ROOT" run --silent cli -- report --run "$RUN_ID"
```

У другій команді замініть шлях на власний наявний файл. Відносний `--input` **завжди від кореня навички**, незалежно від cwd або npm. Абсолютний шлях використовується без зміни. `runtime` лежить у фізичній директорії навички; symlink у різних проєктах використовує спільний runtime. Окремі копії мають окремі дані й залежності. stdout із `--silent` — один JSON; журнали — stderr.

`report` повертає абсолютний шлях до `report.pdf` у `artifacts`. Не вгадуйте останній каталог: використовуйте його `runId`/`reportId`. PDF, SVG, HTML, PNG, JSON і CSV лежать у `runtime/reports/<runId>/<reportId>/`; дослідження — `runtime/runs/<runId>/`. Помилка `report` не є створеним звітом.

## Передача іншій людині

Передавайте чисту копію вихідних файлів і lockfile. Наступний allowlist не включає runtime, node_modules, .env, браузери, приватні дослідження або скомпільовані файли. Вкажіть **нову неіснуючу** директорію призначення:

```bash
DEST="/path to delivery/wiki-interest"
mkdir "$DEST" && tar -C "$WIKI_INTEREST_ROOT" -cf - \
  SKILL.md README.md package.json package-lock.json tsconfig.json \
  .nvmrc .gitignore .env.example src scripts references examples tests \
  | tar -C "$DEST" -xf -
```

Батьківський каталог DEST має існувати. `mkdir` відмовить, якщо DEST уже є; нічого не перезаписуйте. Отримувач виконує `npm ci`, `setup:browser` та підключення вже для нової копії. Файли поза нею не потрібні. Для окремого архівування власних досліджень зберігайте runtime разом із snapshots; це не частина пакета навички для передачі.
