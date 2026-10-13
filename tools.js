/**
 * Инструменты агента для работы с макетами.
 *
 * Девять инструментов закрывают весь цикл проектирования интерфейса агентом:
 * найти проект → создать холст → прочитать состояние → изменить батчем
 * операций → настроить токены и компоненты → проверить → экспортировать в
 * HTML/CSS → убрать лишнее.
 *
 * Каждый инструмент — тонкий адаптер над `service.js`: разобрать аргументы,
 * позвать сервис, отрендерить читаемый текст. Никакой логики макета здесь нет.
 */
import { OPS } from './ops.js'
import {
  ServiceError,
  applyBatch,
  canvasesView,
  componentsView,
  createView,
  exportView,
  initProjectView,
  projectsView,
  readView,
  tokensView,
  trashView,
  validateView,
} from './service.js'

/** Текстовый блок результата инструмента. */
function textBlocks(lines) {
  return [{ type: 'text', text: lines.filter((line) => line !== undefined).join('\n') }]
}

/** Размер в удобочитаемом виде. */
function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`
}

/** Общие параметры адресации холста. */
const PROJECT_PARAM = {
  type: 'string',
  description: 'id проекта из design_projects (например `quizforge`) или путь к его корню. По умолчанию — проект текущего каталога.',
}

const CANVAS_PARAM = {
  type: 'string',
  description: 'id холста внутри проекта (например `home`, `settings-mobile`).',
}

/** Пояснение к каждой операции — попадает в описание инструмента. */
const OP_HELP = {
  add: '{parent, node|type, index?, after?} — добавить узел в контейнер (занятый id заменяется новым, ответ вернёт фактический id).',
  update: '{id|ids, patch} — слить патч (x, y, w, h, name, visible, locked, style.*, text.*, layout.*).',
  move: '{id, parent?, index?, after?} — перенести узел (`after` — id соседа, за которым вставить); без `parent` узел остаётся у того же родителя и меняет порядок.',
  delete: '{id|ids} — удалить узлы с поддеревьями.',
  duplicate: '{id|ids, count?, offsetX?, offsetY?, parent?} — копия рядом.',
  group: '{ids, name?} — обернуть узлы в группу.',
  ungroup: '{id} — развернуть группу обратно в родителя.',
  reorder: '{id, index|direction} — direction: front | back | up | down.',
  'set-tokens': '{tokens, remove?, replace?} — добавить, заменить или удалить токены (remove — пути вида color.bg, text.h1.size).',
  'define-component': '{key, from, name?, description?, props?, convert?} — сделать узел компонентом.',
  'delete-component': '{key, detach?} — убрать компонент (инстансы по умолчанию детачатся).',
  instantiate: '{component, parent, x?, y?, w?, h?, name?, overrides?, index?, after?} — поставить инстанс компонента.',
  detach: '{id} — превратить инстанс в обычный узел.',
  'set-canvas': '{name?, device?} — имя и устройство холста (mobile | tablet | desktop | component; неизвестное значение — ошибка).',
  align: '{ids, mode, axis?} — mode: left | center | right | top | middle | bottom; axis: x | y (иначе выводится из mode, противоречие — ошибка).',
  distribute: '{ids, axis?} — axis: x | y (по умолчанию x), равные промежутки; нужно минимум три узла.',
}

/**
 * Схема операции для `design_apply` — описывается один раз и переиспользуется
 * в описании инструмента, чтобы агент видел полный список в одном месте.
 */
const OP_SCHEMA = {
  type: 'array',
  description: [
    'Список операций, применяемых по порядку и транзакционно (ошибка откатывает весь батч).',
    'Доступные операции:',
    ...OPS.map((op) => `- ${op}: ${OP_HELP[op] ?? ''}`),
  ].join('\n'),
  items: { type: 'object', additionalProperties: true },
}

/**
 * Зарегистрировать инструменты макетов в плагине.
 *
 * @param {object} ctx Контекст плагина Cordis (нужен `ctx.tools`).
 * @param {object} [config] Конфиг плагина.
 */
export function registerTools(ctx, config = {}) {
  const defaultProject = config.project

  // ------------------------------------------------------------ projects ----
  ctx.tools.register({
    name: 'design_projects',
    description:
      'Проекты и холсты макетов: реестр корней, папка .design/, список холстов. Вызывай первым, чтобы понять, в каком проекте рисовать и какие холсты уже есть. Холсты лежат в <root>/.design/<id>.canvas.json и версионируются вместе с кодом.',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Показать один проект и его холсты (id или путь).' },
        canvases: { type: 'boolean', description: 'Показать холсты у всех инициализированных проектов.' },
        init: { type: 'string', description: 'Путь к каталогу: создать в нём .design/ и зарегистрировать как проект.' },
        title: { type: 'string', description: 'Имя проекта при init.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { projects: { type: 'array', items: { type: 'object' } }, configPath: { type: 'string' } } },
      render: (_args, value) => {
        if (value.initialized) {
          return textBlocks([
            `Проект «${value.project.id}» инициализирован: ${value.project.title}.`,
            `Каталог макетов: ${value.project.designPath}`,
            `Корень: ${value.project.root}`,
          ])
        }
        const lines = []
        for (const project of value.projects ?? []) {
          const mark = project.initialized ? '●' : '○'
          lines.push(`${mark} ${project.id} — ${project.title}`)
          lines.push(`    ${project.root}${project.exists ? '' : ' (каталог отсутствует)'}`)
          if (project.canvasList) {
            if (project.canvasList.length === 0) lines.push('    холстов нет')
            for (const canvas of project.canvasList) {
              lines.push(`    · ${canvas.id} — «${canvas.name}», ${canvas.device}, узлов ${canvas.nodes}, rev ${canvas.rev}`)
            }
          } else if (project.canvases > 0) {
            lines.push(`    холстов: ${project.canvases}`)
          }
        }
        lines.push('', `● — есть .design/ (проект инициализирован), ○ — ещё нет. Реестр: ${value.configPath}`)
        lines.push(`Устройства: ${(value.devices ?? []).join(', ')}.`)
        return textBlocks(lines)
      },
    },
    // `init` создаёт `.design/` и пишет реестр — это запись на диск; остальные
    // вызовы только читают.
    isConcurrencySafe: (args) => !args?.init,
    presentCall: () => ({ card: 'generic', title: 'design_projects', kind: 'other' }),
    async execute(args) {
      if (args?.init) return initProjectView(args.init, args.title)
      return projectsView({ project: args?.project ?? defaultProject, canvases: args?.canvases === true })
    },
  })

  // -------------------------------------------------------------- create ----
  ctx.tools.register({
    name: 'design_create',
    description:
      'Создать холст макета в проекте. Холст — это страница макета (обычно один экран приложения) с фреймом устройства по умолчанию. Можно сразу передать ops, чтобы собрать первую версию одним вызовом.',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        name: { type: 'string', description: 'Человекочитаемое имя холста (по умолчанию — id).' },
        device: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'component'], description: 'Размер корневого фрейма.' },
        template: { type: 'string', enum: ['device', 'blank'], description: 'device — фрейм устройства (по умолчанию), blank — пустой холст.' },
        overwrite: { type: 'boolean', description: 'Перезаписать существующий холст.' },
        ops: OP_SCHEMA,
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, rev: { type: 'number' }, path: { type: 'string' }, stats: { type: 'object' } } },
      render: (_args, value) => textBlocks([
        `Холст «${value.canvas}» готов: ${value.name}, ${value.device}, rev ${value.rev}.`,
        `Файл: ${value.path}`,
        `Узлов: ${value.stats?.nodes ?? 0}, компонентов: ${value.stats?.components ?? 0}.`,
        value.hint,
      ]),
      presentationMeta: (_args, value) => ({ files: value.path ? [value.path] : [] }),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `design_create ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return createView(args?.project ?? defaultProject, args?.canvas, {
        name: args?.name,
        device: args?.device,
        template: args?.template,
        overwrite: args?.overwrite === true,
        ops: args?.ops,
      })
    },
  })

  // ---------------------------------------------------------------- read ----
  ctx.tools.register({
    name: 'design_read',
    description:
      'Прочитать холст макета. mode=summary (по умолчанию) — статистика и дерево слоёв; outline — полное дерево; node — один узел (инстансы разворачиваются); tokens — палитра и типографика; components — библиотека компонентов; full — весь документ JSON.',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        mode: { type: 'string', enum: ['summary', 'outline', 'node', 'tokens', 'components', 'full'], description: 'Проекция документа.' },
        node: { type: 'string', description: 'id узла для mode=node.' },
        depth: { type: 'number', description: 'Сколько строк дерева вернуть в summary.' },
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, rev: { type: 'number' }, stats: { type: 'object' }, outline: { type: 'array', items: { type: 'object' } } } },
      render: (args, value) => {
        const lines = [`Холст «${value.canvas}» — «${value.name}», ${value.device}, rev ${value.rev}.`]
        if (value.stats) {
          lines.push(`Узлов ${value.stats.nodes}, фреймов ${value.stats.frames}, текстов ${value.stats.texts}, инстансов ${value.stats.instances}, компонентов ${value.stats.components}, ошибок ${value.stats.errors}.`)
          if (value.stats.topFrames?.length) {
            lines.push(`Верхние фреймы: ${value.stats.topFrames.map((f) => `${f.id} «${f.name}» ${f.w}×${f.h}`).join('; ')}.`)
          }
        }
        if (args?.mode === 'tokens') {
          lines.push('', 'Токены:')
          for (const [path, tokenValue] of Object.entries(value.flat ?? {})) {
            if (typeof tokenValue === 'object') continue
            lines.push(`  ${path} = ${tokenValue}`)
          }
        } else if (args?.mode === 'components') {
          lines.push('', value.components?.length ? 'Компоненты:' : 'Компонентов нет.')
          for (const component of value.components ?? []) {
            lines.push(`  ${component.key} — «${component.name}», ${component.w}×${component.h}, инстансов ${component.instances}`)
            for (const [name, spec] of Object.entries(component.props ?? {})) {
              lines.push(`      ${name}: ${spec.type} = ${JSON.stringify(spec.default)} (${spec.target} → ${spec.property})`)
            }
          }
        } else if (args?.mode === 'node') {
          lines.push('', JSON.stringify(value.node, null, 2))
        } else if (args?.mode === 'full') {
          lines.push('', JSON.stringify(value.doc))
        } else if (value.outline) {
          lines.push('', 'Дерево:')
          for (const node of value.outline) {
            lines.push(`${'  '.repeat(node.depth)}${node.type === 'instance' ? '◆' : '·'} ${node.id} «${node.name}» ${node.x},${node.y} ${node.w}×${node.h}${node.component ? ` → ${node.component}` : ''}`)
          }
        }
        return textBlocks(lines)
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `design_read ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return readView(args?.project ?? defaultProject, args?.canvas, {
        mode: args?.mode,
        node: args?.node,
        depth: args?.depth,
      })
    },
  })

  // --------------------------------------------------------------- apply ----
  ctx.tools.register({
    name: 'design_apply',
    description: [
      'Изменить холст батчем операций. Это основной рабочий инструмент: собрать экран, подвинуть, перекрасить, объявить компонент, поставить инстансы.',
      'Батч транзакционный: ошибка в любой операции откатывает весь батч, документ остаётся прежним.',
      'Операции применяются к копии, ревизия (rev) растёт на 1 — используй её для защиты от параллельных правок из панели.',
      '',
      OP_SCHEMA.description,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        ops: OP_SCHEMA,
        expectRev: { type: 'number', description: 'Ожидаемая ревизия холста; несовпадение — отказ 409 (защита от затирания правок из панели).' },
        force: { type: 'boolean', description: 'Игнорировать expectRev.' },
        create: { type: 'boolean', description: 'Создать холст, если его ещё нет (по умолчанию true).' },
        name: { type: 'string', description: 'Имя холста при создании.' },
      },
      required: ['canvas', 'ops'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, rev: { type: 'number' }, applied: { type: 'array', items: { type: 'object' } }, stats: { type: 'object' } } },
      render: (_args, value) => {
        const lines = [`Холст «${value.canvas}», rev ${value.rev}: применено операций ${(value.applied ?? []).length}.`]
        for (const entry of value.applied ?? []) {
          const ids = entry.ids ?? entry.id
          lines.push(`  ${entry.index + 1}. ${entry.op}${ids ? ` → ${Array.isArray(ids) ? ids.join(', ') : ids}` : ''}`)
        }
        lines.push(`Узлов ${value.stats?.nodes ?? 0}, компонентов ${value.stats?.components ?? 0}.`)
        if ((value.issues ?? []).length > 0) {
          lines.push('', 'Ошибки в документе:')
          for (const issue of value.issues) lines.push(`  ${issue.code}: ${issue.message}`)
        }
        return textBlocks(lines)
      },
      presentationMeta: (_args, value) => ({ files: value.path ? [value.path] : [] }),
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `design_apply ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return applyBatch(args?.project ?? defaultProject, args?.canvas, args?.ops, {
        expectRev: args?.expectRev,
        force: args?.force === true,
        create: args?.create !== false,
        name: args?.name,
      })
    },
  })

  // -------------------------------------------------------------- tokens ----
  ctx.tools.register({
    name: 'design_tokens',
    description:
      'Палитра, типографика, радиусы, отступы и тени холста. Без аргументов — чтение; с tokens/remove — запись. Значения-токены подставляются в узлы ссылкой `token:color.bg`, поэтому смена токена перекрашивает весь макет. Экспорт превращает их в CSS-переменные `--color-bg`.',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        tokens: { type: 'object', description: 'Токены для записи, сгруппированные: { color: { bg: "#0b0d10" }, text: { h1: { size: 32, weight: 700 } } }.' },
        replace: { type: 'boolean', description: 'Заменить весь набор токенов, а не дополнить.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Пути токенов для удаления, например ["color.brand"].' },
        expectRev: { type: 'number', description: 'Ожидаемая ревизия для защиты от параллельной правки.' },
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, rev: { type: 'number' }, written: { type: 'boolean' }, flat: { type: 'object' } } },
      render: (_args, value) => {
        const lines = [`Холст «${value.canvas}», rev ${value.rev}: токены ${value.written ? 'записаны' : 'прочитаны'}.`]
        const flat = value.flat ?? {}
        const groups = {}
        for (const [path, tokenValue] of Object.entries(flat)) {
          if (typeof tokenValue === 'object') continue
          const [group] = path.split('.')
          groups[group] = groups[group] ?? []
          groups[group].push(`${path} = ${tokenValue}`)
        }
        for (const [group, entries] of Object.entries(groups)) {
          lines.push('', `${group}:`)
          for (const entry of entries) lines.push(`  ${entry}`)
        }
        const objects = Object.entries(flat).filter(([, v]) => typeof v === 'object')
        if (objects.length > 0) {
          lines.push('', 'Составные токены (типографика, тени):')
          for (const [path, tokenValue] of objects) lines.push(`  ${path} = ${JSON.stringify(tokenValue)}`)
        }
        return textBlocks(lines)
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `design_tokens ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return tokensView(args?.project ?? defaultProject, args?.canvas, {
        tokens: args?.tokens,
        replace: args?.replace === true,
        remove: args?.remove,
        expectRev: args?.expectRev,
      })
    },
  })

  // ---------------------------------------------------------- components ----
  ctx.tools.register({
    name: 'design_components',
    description: [
      'Библиотека компонентов холста — аналог компонентов Figma.',
      'Компонент объявляется из готового узла (action=define, from=<id>) и дальше ставится инстансами (action=instantiate).',
      'Инстанс — живая ссылка: правка компонента обновляет все инстансы. Переопределения инстанса задаются через overrides и объявленные параметры компонента.',
      'Параметр компонента описывается как { type, default, target, property }: target — «root», «#Имя узла», «text» или путь внутри шаблона (`children[0].label`), property — путь внутри узла (text.value, style.fill, w).',
      'Действия: list, get, define, delete, instantiate, detach.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        action: { type: 'string', enum: ['list', 'get', 'define', 'delete', 'instantiate', 'detach'], description: 'Действие; по умолчанию list.' },
        key: { type: 'string', description: 'Ключ компонента (латиница, цифры, «-», «_»).' },
        from: { type: 'string', description: 'id узла: основа для define или инстанс для detach.' },
        name: { type: 'string', description: 'Имя компонента.' },
        description: { type: 'string', description: 'Назначение компонента.' },
        props: { type: 'object', description: 'Объявленные параметры: { label: { type: "text", default: "Кнопка", target: "text", property: "text.value" } }. target: «root», «#Имя узла», «text» или путь внутри шаблона (`children[0].label`).' },
        convert: { type: 'boolean', description: 'define: превратить исходный узел в инстанс (по умолчанию true).' },
        detach: { type: 'boolean', description: 'delete: развернуть инстансы в обычные узлы (по умолчанию true).' },
        overrides: { type: 'object', description: 'instantiate: значения параметров инстанса.' },
        parent: { type: 'string', description: 'instantiate: id родителя (по умолчанию root).' },
        x: { type: 'number', description: 'instantiate: позиция X.' },
        y: { type: 'number', description: 'instantiate: позиция Y.' },
        w: { type: 'number', description: 'instantiate: ширина.' },
        h: { type: 'number', description: 'instantiate: высота.' },
        expectRev: { type: 'number', description: 'Ожидаемая ревизия.' },
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, rev: { type: 'number' }, components: { type: 'array', items: { type: 'object' } }, component: { type: 'object' } } },
      render: (_args, value) => {
        if (value.component) {
          return textBlocks([`Компонент «${value.component.key}» — «${value.component.name}».`, '', JSON.stringify(value.component, null, 2)])
        }
        if (value.components) {
          if (value.components.length === 0) return textBlocks([`На холсте «${value.canvas}» компонентов нет. Объяви первый: action=define, from=<id узла>.`])
          const lines = [`Компоненты холста «${value.canvas}» (rev ${value.rev}):`]
          for (const component of value.components) {
            lines.push(`  ${component.key} — «${component.name}», ${component.w}×${component.h}, инстансов ${component.instances}`)
            for (const [name, spec] of Object.entries(component.props ?? {})) {
              lines.push(`      ${name}: ${spec.type} = ${JSON.stringify(spec.default)} → ${spec.target}.${spec.property}`)
            }
          }
          return textBlocks(lines)
        }
        const lines = [`Холст «${value.canvas}», rev ${value.rev}: применено ${(value.applied ?? []).length} операций.`]
        for (const entry of value.applied ?? []) lines.push(`  ${entry.op} → ${entry.key ?? entry.id ?? entry.ids ?? ''}`)
        return textBlocks(lines)
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `design_components ${args?.action ?? 'list'}`.trim(), kind: 'other' }),
    async execute(args) {
      return componentsView(args?.project ?? defaultProject, args?.canvas, args ?? {})
    },
  })

  // -------------------------------------------------------------- export ----
  ctx.tools.register({
    name: 'design_export',
    description:
      'Экспорт холста в HTML и CSS в <root>/.design/exports/. Токены становятся CSS-переменными (--color-bg), у каждого элемента есть data-node с id узла макета. mode=fidelity — пиксельно точный абсолютный макет (превью, handoff); mode=clean — потоковые фреймы через flex там, где задан layout.mode (ближе к вёрстке приложения). Дополнительно пишется страница-библиотека компонентов.',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        mode: { type: 'string', enum: ['fidelity', 'clean'], description: 'Режим генерации CSS.' },
        frame: { type: 'string', description: 'Экспортировать только один верхний фрейм по id.' },
        write: { type: 'boolean', description: 'Писать файлы на диск (по умолчанию true).' },
        preview: { type: 'boolean', description: 'Вернуть готовый HTML со встроенным CSS — можно сразу показать.' },
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, files: { type: 'array', items: { type: 'object' } }, warnings: { type: 'array', items: { type: 'string' } } } },
      render: (_args, value) => {
        const lines = [`Экспорт холста «${value.canvas}» (${value.mode}):`]
        for (const file of value.files ?? []) lines.push(`  ${file.name} — ${formatBytes(file.bytes)}${file.path ? ` → ${file.path}` : ''}`)
        if ((value.warnings ?? []).length > 0) {
          lines.push('', 'Предупреждения:')
          for (const warning of value.warnings) lines.push(`  ${warning}`)
        }
        lines.push('', value.hint)
        return textBlocks(lines)
      },
      presentationMeta: (_args, value) => ({ files: (value.files ?? []).map((file) => file.path).filter(Boolean) }),
    },
    // По умолчанию инструмент пишет файлы в `.design/exports/`; параллелить
    // можно только чистый рендер (`write: false`).
    isConcurrencySafe: (args) => args?.write === false,
    presentCall: (args) => ({ card: 'generic', title: `design_export ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return exportView(args?.project ?? defaultProject, args?.canvas, {
        mode: args?.mode,
        frame: args?.frame,
        write: args?.write !== false,
        preview: args?.preview === true,
      })
    },
  })

  // ------------------------------------------------------------ validate ----
  ctx.tools.register({
    name: 'design_validate',
    description:
      'Проверить макет перед сдачей: дубли id, битые инстансы, отсутствующие токены, обрезанные дети, контраст текста к фону, пустые фреймы. Возвращает замечания по уровням error/warn/info и статистику.',
    parameters: {
      type: 'object',
      properties: {
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        contrast: { type: 'boolean', description: 'Проверять контраст текста (по умолчанию true).' },
      },
      required: ['canvas'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { canvas: { type: 'string' }, issues: { type: 'array', items: { type: 'object' } }, stats: { type: 'object' } } },
      render: (_args, value) => {
        const stats = value.stats ?? {}
        const lines = [
          `Холст «${value.canvas}»: узлов ${stats.nodes}, фреймов ${stats.frames}, текстов ${stats.texts}, инстансов ${stats.instances}, компонентов ${stats.components}, токенов ${stats.tokens}.`,
          `Ошибок: ${stats.errors}, предупреждений: ${stats.warnings}.`,
        ]
        if ((value.issues ?? []).length === 0) {
          lines.push('Замечаний нет — макет структурно чистый.')
        } else {
          lines.push('')
          for (const issue of value.issues.slice(0, 60)) {
            lines.push(`[${issue.level}] ${issue.code}: ${issue.message}`)
          }
          if (value.issues.length > 60) lines.push(`… ещё ${value.issues.length - 60}.`)
        }
        return textBlocks(lines)
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `design_validate ${args?.canvas ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return validateView(args?.project ?? defaultProject, args?.canvas, { contrast: args?.contrast !== false })
    },
  })

  // -------------------------------------------------------------- delete ----
  ctx.tools.register({
    name: 'design_delete',
    description:
      'Управление холстами и корзиной: action=list — записи корзины, action=delete — убрать холст в корзину (восстановимо), action=restore — вернуть холст из корзины по trashId.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'delete', 'restore'], description: 'Действие.' },
        project: PROJECT_PARAM,
        canvas: CANVAS_PARAM,
        trashId: { type: 'string', description: 'Метка записи корзины для restore.' },
        overwrite: { type: 'boolean', description: 'Перезаписать холст при восстановлении.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { action: { type: 'string' }, entries: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => {
        if (value.action === 'list') {
          if ((value.entries ?? []).length === 0) return textBlocks(['Корзина макетов пуста.'])
          const lines = ['Корзина макетов:']
          for (const entry of value.entries) {
            lines.push(`  ${entry.trashId} — ${entry.project ?? '?'}/${entry.canvas ?? '?'} (${entry.deletedAt ?? '?'})`)
          }
          return textBlocks(lines)
        }
        if (value.action === 'restore') return textBlocks([`Холст «${value.canvas}» возвращён в проект «${value.project}».`])
        return textBlocks([`Холст «${value.canvas}» убран в корзину (${value.trashId}). Восстановить: design_delete action=restore trashId=${value.trashId}.`])
      },
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', title: `design_delete ${args?.action ?? ''}`.trim(), kind: 'other' }),
    async execute(args) {
      return trashView({
        action: args?.action,
        project: args?.project ?? defaultProject,
        canvas: args?.canvas,
        trashId: args?.trashId,
        overwrite: args?.overwrite === true,
      })
    },
  })
}

export { ServiceError }
