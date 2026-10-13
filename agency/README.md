# The Agency: эксперты и команда для разработки плагина

Определения лежат в проекте и версионируются вместе с кодом; живут они в профиле DSH — в конфиге
плагина `agency-agents` внутри `~/.dsh/profiles/<профиль>/cordis.patch.yml`. Переносит их туда
`../tools/agency-sync.mjs`.

```
agency/
  experts/
    dsh-plugin-developer.yml      # «Разработчик плагинов DSH» (division: engineering)
    visual-editor-architect.yml   # «Архитектор визуального редактора» (division: design)
  teams/
    design-canvas.yml             # команда «Разработка Design Canvas», 8 ролей
```

## Применение

```bash
npm run agency:check            # только сверка: код 1, если профиль разошёлся с agency/
node tools/agency-sync.mjs      # запись в профиль (резервная копия рядом с патчем)
node tools/agency-sync.mjs --dry-run   # показать блок, ничего не писать
```

Профиль берётся из `DSH_PROFILE_DIR`, иначе из `DSH_PROFILE`, иначе `web`. Профиль живой: запись
подхватывается без перезапуска. Проверить можно `list_experts` / `list_expert_teams`.

## Что делает синхронизация

- Правит **только** блок `- id: agency-agents`; остальной патч остаётся байт в байт.
- Проектные записи (`customExperts`, `customTeams`, `enabledTeams`) перезаписываются по файлам
  проекта; записи, добавленные человеком через страницу «Эксперт», сохраняются.
- Slug экспертов и id команды добавляются в `enabled` / `enabledTeams`.
- Перед записью определения проверяются по схеме The Agency (длины, типы, формат slug, `builtin`,
  непустые примеры и промпт): плохой файл не должен ломать каталог экспертов в профиле.
- Новый текст патча разбирается YAML-парсером — иначе харнесс не загрузит профиль.
- Рядом с патчем остаётся резервная копия `cordis.patch.yml.bak-agency-<дата>`.

## Как добавить роль или команду

1. Новый эксперт: `agency/experts/<имя>.yml` со свежим `slug: custom-<uuid v4>` (получить:
   `node -e "console.log('custom-'+require('crypto').randomUUID())"`). Поля: `name` (до 40),
   `description` (до 160), `division` (латиница: `engineering`, `design`, `testing`…),
   `emoji`, `avatar` 0–35, `prompt`.
2. Роль в команде: `agency/teams/design-canvas.yml` — элемент `members` с `expertSlug`, `duty`
   (до 100) и `instructions` (до 2000). Участников от 2 до 8, повторов быть не должно.
3. `npm run agency:check` → `node tools/agency-sync.mjs`.

Правила формулировок: в `instructions` участнику — что проверить, в каком файле, что вернуть и чего
не делать (например, не переустанавливать плагин, не выдавать предположение за факт). Роли не
дублируют друг друга: один объект проверки — один ответственный.
