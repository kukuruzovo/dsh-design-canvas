---
name: design-canvas-context
description: "Карта проекта «Design Canvas» — плагина DSH с инструментами design_* и панелью «Макеты». Загружать первым при любой задаче в /home/kurill/dsh-plugins/dsh-design-canvas: где лежат слои, канон, команды проверок, как устроена установка и перезагрузка. Триггеры: design canvas, dsh-design-canvas, панель Макеты, плагин макетов, холст, .design, design_* инструменты, где что лежит в плагине."
---

# Design Canvas — карта проекта

Плагин DeepSeek Harness: **инструменты агента `design_*`** и **панель «Макеты»** в веб-интерфейсе
работают с одними файлами `<проект>/.design/*.canvas.json`. Человек и агент правят один документ,
поэтому дизайн не расходится с кодом приложения.

Корень: `/home/kurill/dsh-plugins/dsh-design-canvas`. Плагин подключён как `link:` в профиль `web`.

## Что читать до правки

| Вопрос | Источник |
|---|---|
| Что умеет плагин, модель документа, операции, экспорт, установка | `README.md` — пользовательский канон |
| Границы слоёв, инварианты, стиль, правила сдачи | `AGENTS.md` — уже в контексте проекта |
| Слои, зависимости, рецепты расширения, коды ошибок | `docs/ARCHITECTURE.md` |
| Найденные, но не исправленные дефекты | `docs/BACKLOG.md` — сверься перед «нашёл баг» |
| Процедура под конкретный слой | скилы `design-canvas-core`, `design-canvas-panel`, `design-canvas-quality` |

Проверь `docs/BACKLOG.md` прежде чем объявлять находку новой: часть дефектов уже описана там.

## Файлы

| Файл | Слой | Строк |
|---|---|---|
| `schema.js` | модель: нормализация, дерево, токены, компоненты, layout, валидация | ~1091 |
| `store.js` | файлы: реестр, `.design/`, ревизии, корзина, атомарная запись | ~644 |
| `ops.js` | 16 операций над документом, транзакционно | ~662 |
| `export.js` | HTML/CSS, режимы `fidelity` / `clean` | ~449 |
| `service.js` | сценарии — общая логика инструментов и панели | ~508 |
| `tools.js` | 9 инструментов `design_*` — тонкий адаптер | ~557 |
| `route.js` | HTTP `/api/dsh-design-canvas` — тонкий адаптер | ~196 |
| `index.js` | точка входа Cordis: инструменты + маршрут | ~44 |
| `client.js` | панель-редактор: React без JSX, браузерный бандл | ~4040 |
| `smoke*.mjs`, `demo.mjs` | проверки и демо-фикстура | — |
| `tools/agency-sync.mjs`, `tools/preview.mjs` | эксперты The Agency; превью `demo/preview*.png` для README | — |

## Команды

```bash
npm run check                 # node --check по всем .js/.mjs
npm test                      # ядро + инструменты/маршрут + контракт клиента
npm run demo                  # пересобрать demo/.design/quiz-home.canvas.json
npm run preview               # пересобрать demo/preview*.png (картинки README) из экспорта
DSH_WEB_TOKEN=… node smoke-gui.mjs http://127.0.0.1:3080 .gui-shot.png   # панель в живом DSH
npm run agency:check          # сверка agency/ с профилем The Agency
```

Живой прогон панели требует запущенного DSH и токена из адресной строки; Playwright берётся из
установки или кеша `npx`.

## Где живут данные

- Холсты проекта: `<корень проекта>/.design/<canvas-id>.canvas.json`, экспорт — `.design/exports/`.
- Реестр корней: `~/.dsh/design-canvas.json` (мержится поверх встроенного списка проектов в `store.js`).
- Корзина удалённых холстов: `~/.dsh/design-trash/` — восстановимо.
- Демо-фикстура панели: `demo/.design/quiz-home.canvas.json` (её использует `smoke-gui.mjs`).

## Установка и перезагрузка

Плагин — npm-пакет с двумя половинами: Host (`index.js` + `dsh.bundle.patch` → `cordis.patch.yml`)
и клиент (`client.js` + `dsh.client`).

- Правка Host-половины подхватывается **перезапуском `dsh web`**.
- Правка `client.js` — **перезагрузкой страницы**; на лету только при запущенном `pnpm run dev:web`.
- `package.json` и `cordis.patch.yml` профиля вручную не правятся: установка идёт через
  `plugin_manager` (`install_bundle`), каждое его действие требует подтверждения человека.
- Глобальный скил по механике плагинов DSH — `cordis-plugin-development`; по описаниям инструментов —
  `agent-experience`.

## Границы задачи

- Задача целиком внутри этого проекта → проектная синхронизация и ретроспектива, глобальную
  `knowledge-base` не запускай.
- Правка чужих проектов пользователя (Kendra, QuizForge, Español Vivo, BioPath, Godot) — только если
  она прямо входит в задачу: их `.design/` это данные, а не код плагина.
