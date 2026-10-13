/**
 * Хранилище макетов: реестр проектов и файлы `<root>/.design/`.
 *
 * Холсты живут в репозитории проекта, а не в домашнем каталоге DSH: дизайн
 * едет вместе с кодом в git, лежит рядом с приложением и переносится между
 * машинами. Центральный реестр (`$DSH_HOME/design-canvas.json`) только
 * сопоставляет корни проектов с их id и папкой канона.
 *
 * Раскладка одного проекта:
 *
 *     <root>/.design/
 *       project.json         — необязательные метаданные (title, description)
 *       <canvas-id>.canvas.json — документ макета (см. schema.js)
 *       exports/             — сгенерированные HTML/CSS/ассеты
 *
 * Модуль не знает про HTTP и React: им пользуются и инструменты агента, и
 * маршрут панели, поэтому вся работа с диском сосредоточена здесь.
 */
import { readFile, writeFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DOC_FORMAT, cloneDoc, defaultDocument, normalizeDoc } from './schema.js'

/** Имя папки с макетами внутри проекта. */
export const DESIGN_DIR = '.design'
/** Суффикс файла холста. */
export const CANVAS_EXT = '.canvas.json'
/** Подпапка для экспортированных артефактов. */
export const EXPORT_DIR = 'exports'

const HOME = homedir()

/**
 * Домашний каталог DSH читается лениво, а не на импорте: тесты и вызывающая
 * сторона могут подменить `DSH_HOME` до первого обращения к реестру.
 */
function dshHome() {
  return process.env.DSH_HOME || join(HOME, '.dsh')
}

/** Путь к реестру проектов. */
function configFile() {
  return process.env.DSH_DESIGN_CONFIG || join(dshHome(), 'design-canvas.json')
}

/** Каталог восстановимой корзины макетов. */
function trashRoot() {
  return join(dshHome(), 'design-trash')
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_CANVAS_BYTES = 8 * 1024 * 1024
let tmpSeq = 0

/** Ошибка операции: маршрут панели отдаёт `status` клиенту как есть. */
export class StoreError extends Error {
  constructor(status, message, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

function fail(status, message, payload) {
  throw new StoreError(status, message, payload)
}

/**
 * Проекты по умолчанию — корни из реестра проектов пользователя.
 * Совпадает с таблицей проектов в глобальном `AGENTS.md`.
 */
const DEFAULT_PROJECTS = {
  kendra: { title: 'Kendra — Discord RPG-бот', root: join(HOME, 'operativ/main/kendra/repo/KendraMSR-discord_bot') },
  'kendra-world': { title: 'Kendra — документация мира', root: join(HOME, 'operativ/main/kendra/docs/kendra_docs') },
  quizforge: { title: 'QuizForge', root: join(HOME, 'operativ/main/QuizForge') },
  'espanol-vivo': { title: 'Español Vivo', root: join(HOME, 'operativ/main/espanol-vivo') },
  biopath: { title: 'BioPath (Unity)', root: join(HOME, 'operativ/unity/projects/biopath') },
  mondala: { title: 'mondala (Godot)', root: join(HOME, 'operativ/main/godot-projects/mondala') },
  'logistics-sim': { title: 'Логистик симулятор (Godot)', root: join(HOME, 'operativ/main/godot-projects/logistics-sim') },
}

/**
 * Прочитать конфиг реестра: `$DSH_HOME/design-canvas.json` поверх дефолтов.
 *
 * @returns {{projects: Record<string, object>, defaultProject: string|null}}
 */
export function loadConfig() {
  let raw = {}
  if (existsSync(configFile())) {
    try {
      raw = JSON.parse(readFileSafe(configFile())) ?? {}
    } catch {
      raw = {}
    }
  }
  const projects = {}
  for (const [id, value] of Object.entries(DEFAULT_PROJECTS)) projects[id] = { ...value }
  if (raw.projects && typeof raw.projects === 'object') {
    for (const [id, value] of Object.entries(raw.projects)) {
      if (!ID_RE.test(id)) continue
      if (value === null) {
        delete projects[id]
        continue
      }
      const entry = typeof value === 'string' ? { root: value } : value
      if (!entry || typeof entry.root !== 'string') continue
      projects[id] = { title: entry.title ?? id, root: resolve(expandHome(entry.root)), ...entry }
      projects[id].root = resolve(expandHome(entry.root))
    }
  }
  return {
    projects,
    defaultProject: typeof raw.defaultProject === 'string' ? raw.defaultProject : null,
  }
}

/** Синхронное чтение небольшого файла (конфиг читается на каждый вызов). */
function readFileSafe(path) {
  return readFileSync(path, 'utf8')
}

/** Развернуть ведущий `~` в домашний каталог. */
export function expandHome(path) {
  if (path === '~') return HOME
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) return join(HOME, path.slice(2))
  return path
}

/**
 * Реестр проектов с признаком наличия папки `.design/`.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listProjects() {
  const cfg = loadConfig()
  const out = []
  for (const [id, project] of Object.entries(cfg.projects)) {
    const designPath = join(project.root, DESIGN_DIR)
    const hasDesign = existsSync(designPath)
    out.push({
      id,
      title: project.title ?? id,
      root: project.root,
      designPath,
      exists: existsSync(project.root),
      initialized: hasDesign,
      canvases: hasDesign ? (await listCanvases(id)).length : 0,
    })
  }
  out.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
  return out
}

/**
 * Найти проект по ссылке: id из реестра, абсолютный путь или cwd.
 *
 * Порядок разрешения:
 *  1. точное совпадение с id реестра;
 *  2. путь внутри корня известного проекта (включая сам корень);
 *  3. подъём вверх по дереву в поисках существующей папки `.design/`;
 *  4. явный `create: true` — создать `.design/` в указанном каталоге.
 *
 * @param {string|undefined} ref id проекта или путь.
 * @param {object} [opts] `{ create: boolean, cwd: string, title: string }`.
 * @returns {Promise<object>} Запись проекта `{ id, title, root, designPath }`.
 */
export async function resolveProject(ref, opts = {}) {
  const cfg = loadConfig()
  const wanted = typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : undefined

  if (wanted && cfg.projects[wanted]) {
    return projectEntry(wanted, cfg.projects[wanted])
  }

  const start = resolve(expandHome(wanted ?? opts.cwd ?? process.cwd()))
  const known = findKnownProject(cfg.projects, start)
  if (known) return projectEntry(known.id, known.project)

  if (wanted) {
    const stat_ = safeStat(start)
    if (stat_?.isDirectory()) {
      const discovered = await discoverUpward(start)
      if (discovered) return await adoptProject(discovered)
      if (opts.create) return ensureProject(start, opts.title ?? basename(start))
      fail(400, `Каталог «${start}» не является проектом: нет папки ${DESIGN_DIR}/. Передай id проекта из design_projects или create=true.`)
    }
    fail(404, `Проект «${wanted}» не найден в реестре и как каталог.`)
  }

  const discovered = await discoverUpward(start)
  if (discovered) return await adoptProject(discovered)
  if (opts.create) return ensureProject(start, opts.title ?? basename(start))
  const fallbackId = cfg.defaultProject ?? Object.keys(cfg.projects)[0]
  if (fallbackId && cfg.projects[fallbackId]) return projectEntry(fallbackId, cfg.projects[fallbackId])
  fail(400, `Не удалось определить проект по каталогу «${start}».`)
}

/** Запись проекта с вычисленным путём к `.design/`. */
function projectEntry(id, project) {
  const root = resolve(expandHome(project.root))
  return {
    id,
    title: project.title ?? id,
    root,
    designPath: join(root, DESIGN_DIR),
    initialized: existsSync(join(root, DESIGN_DIR)),
  }
}

/**
 * Взять найденный по каталогу проект в реестр и вернуть его запись.
 *
 * Проект, обнаруженный подъёмом по дереву, иначе остаётся адресуемым только
 * путём: `resolveProject` по id знает лишь реестр, поэтому `design_create` и
 * `design_apply` с этим id падали 404 (сценарий «клонировали репозиторий с
 * закоммиченной папкой `.design/`»). Регистрация идемпотентна и не роняет
 * вызов, если реестр недоступен на запись.
 *
 * @param {object} discovered Запись из `discoverUpward`.
 * @returns {Promise<object>} Каноническая запись проекта.
 */
async function adoptProject(discovered) {
  const id = await registerProject(discovered.root, discovered.title)
  return projectEntry(id, { title: discovered.title, root: discovered.root })
}

/** Найти известный проект, содержащий путь (или равный ему). */
function findKnownProject(projects, path) {
  let best = null
  for (const [id, project] of Object.entries(projects)) {
    const root = resolve(expandHome(project.root))
    if (path === root || path.startsWith(root + sep)) {
      if (!best || root.length > best.root.length) best = { id, project: { ...project, root } }
    }
  }
  return best
}

/** Подъём от каталога вверх: первый найденный `.design/` задаёт проект. */
async function discoverUpward(start) {
  let current = start
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(current, DESIGN_DIR))) {
      return { id: basename(current), title: basename(current), root: current, designPath: join(current, DESIGN_DIR), initialized: true }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Создать `.design/` в каталоге и вернуть запись проекта. */
export async function ensureProject(root, title) {
  const abs = resolve(expandHome(root))
  const stat_ = safeStat(abs)
  if (!stat_ || !stat_.isDirectory()) fail(404, `Каталог «${abs}» не существует.`)
  const designPath = join(abs, DESIGN_DIR)
  await mkdir(designPath, { recursive: true })
  await ensureProjectMeta(designPath, basename(abs), title)
  const id = await registerProject(abs, title ?? basename(abs))
  return { id, title: title ?? basename(abs), root: abs, designPath, initialized: true }
}

/**
 * Метаданные проекта в `.design/project.json`, если файла ещё нет.
 *
 * Файл необязательный, но README обещает его наличие: проект, найденный по id
 * в реестре или подъёмом по дереву, до первой записи холста оставался без него.
 *
 * @param {string} designPath Каталог `.design/`.
 * @param {string} id id проекта.
 * @param {string} [title] Отображаемое имя.
 * @returns {Promise<void>}
 */
async function ensureProjectMeta(designPath, id, title) {
  const metaPath = join(designPath, 'project.json')
  if (existsSync(metaPath)) return
  await writeJsonAtomic(metaPath, { id, title: title ?? id, createdAt: new Date().toISOString() })
}

/**
 * Записать проект в реестр `$DSH_HOME/design-canvas.json`.
 *
 * Без этого проект, найденный по каталогу, нельзя было бы потом назвать по id:
 * `resolveProject` знает только реестр и пути. Регистрация идемпотентна, при
 * совпадении имени каталога с чужим корнем id получает числовой суффикс.
 *
 * @param {string} root Абсолютный корень проекта.
 * @param {string} title Отображаемое имя.
 * @returns {Promise<string>} id проекта в реестре.
 */
export async function registerProject(root, title) {
  const abs = resolve(expandHome(root))
  const cfg = loadConfig()
  for (const [id, project] of Object.entries(cfg.projects)) {
    if (resolve(expandHome(project.root)) === abs) return id
  }
  const base = basename(abs).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'project'
  let id = base
  let n = 2
  while (cfg.projects[id]) {
    id = `${base}-${n}`
    n += 1
  }
  const raw = existsSync(configFile()) ? safeParse(readFileSafe(configFile())) : {}
  const next = { ...raw, projects: { ...(raw.projects ?? {}), [id]: { title: title ?? base, root: abs } } }
  try {
    await writeJsonAtomic(configFile(), next)
  } catch {
    // Реестр недоступен на запись — работаем по пути; это не повод ронять вызов.
    return id
  }
  return id
}

/** Разбор JSON без исключения. */
function safeParse(text) {
  try {
    return JSON.parse(text) ?? {}
  } catch {
    return {}
  }
}

/** `stat` без исключения: null, если путь недоступен. */
function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * Список холстов проекта: id, имя, устройство, число узлов, время правки.
 *
 * @param {string} projectRef id проекта или путь.
 * @returns {Promise<Array<object>>}
 */
export async function listCanvases(projectRef) {
  const project = await resolveProject(projectRef)
  if (!existsSync(project.designPath)) return []
  const entries = await readdir(project.designPath, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(CANVAS_EXT)) continue
    const id = entry.name.slice(0, -CANVAS_EXT.length)
    if (!ID_RE.test(id)) continue
    const path = join(project.designPath, entry.name)
    const info = await safeStatAsync(path)
    let meta = { name: id, device: 'mobile', nodes: 0 }
    try {
      const doc = normalizeDoc(JSON.parse(await readFile(path, 'utf8')), id)
      meta = { name: doc.name, device: doc.device, nodes: countTree(doc.root), components: Object.keys(doc.components).length }
    } catch {
      meta = { name: id, device: 'unknown', nodes: 0, broken: true }
    }
    out.push({
      id,
      project: project.id,
      ...meta,
      rev: await readRev(path),
      size: info?.size ?? 0,
      updatedAt: info ? new Date(info.mtimeMs).toISOString() : null,
    })
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return out
}

/** Число узлов в дереве. */
function countTree(root) {
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node !== root) count += 1
    for (const child of node.children ?? []) stack.push(child)
  }
  return count
}

/** `stat` без исключения (асинхронный). */
async function safeStatAsync(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Текущая ревизия файла холста: 0, если файла нет. */
async function readRev(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    return Number.isFinite(raw?.rev) ? raw.rev : 1
  } catch {
    return 0
  }
}

/** Путь к файлу холста внутри проекта (с проверкой id). */
export function canvasPath(project, canvasId) {
  if (!ID_RE.test(canvasId)) fail(400, `Недопустимый id холста «${canvasId}»: буквы, цифры, «_» и «-», до 64 символов.`)
  return join(project.designPath, `${canvasId}${CANVAS_EXT}`)
}

/**
 * Прочитать холст.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @returns {Promise<{doc: object, rev: number, path: string, project: object}>}
 */
export async function readCanvas(projectRef, canvasId) {
  const project = await resolveProject(projectRef)
  const path = canvasPath(project, canvasId)
  if (!existsSync(path)) fail(404, `Холст «${canvasId}» не найден в проекте «${project.id}».`)
  const info = await safeStatAsync(path)
  if (info && info.size > MAX_CANVAS_BYTES) fail(413, `Холст больше ${Math.round(MAX_CANVAS_BYTES / 1024 / 1024)} МБ.`)
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail(500, `Файл холста повреждён: ${error.message}`)
  }
  if (raw.format && raw.format !== DOC_FORMAT) {
    fail(400, `Файл не является холстом DSH (format «${raw.format}»).`)
  }
  const doc = normalizeDoc(raw, canvasId)
  return { doc, rev: Number.isFinite(raw.rev) ? raw.rev : 1, path, project }
}

/**
 * Записать холст.
 *
 * Ревизия — оптимистическая блокировка: если передан `expectRev` и он не
 * совпадает с файлом, запись отклоняется (409), пока не пришёл `force`.
 * Так параллельные правки редактора и агента не затирают друг друга молча.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} doc Документ (будет нормализован).
 * @param {object} [opts] `{ expectRev, force, create }`.
 * @returns {Promise<{doc: object, rev: number, path: string}>}
 */
export async function writeCanvas(projectRef, canvasId, doc, opts = {}) {
  const project = await resolveProject(projectRef, { create: opts.create === true })
  return writeCanvasTo(project, canvasId, doc, opts)
}

/**
 * Записать холст в уже разрешённый проект.
 *
 * Отдельная ветка нужна вызывающим, которые разрешили проект сами (`createCanvas`):
 * повторное разрешение по `project.id` — лишний проход по реестру и каталогам, а для
 * проекта, найденного подъёмом по дереву до регистрации, он отвечал 404.
 *
 * @param {object} project Запись проекта из `resolveProject`.
 * @param {string} canvasId id холста.
 * @param {object} doc Документ (будет нормализован).
 * @param {object} [opts] `{ expectRev, force, create }`.
 * @returns {Promise<{doc: object, rev: number, path: string, project: object}>}
 */
async function writeCanvasTo(project, canvasId, doc, opts = {}) {
  const path = canvasPath(project, canvasId)
  const exists = existsSync(path)
  if (!exists && opts.create !== true) {
    fail(404, `Холст «${canvasId}» не найден. Создай его через design_create.`)
  }
  const currentRev = exists ? await readRev(path) : 0
  if (exists && opts.expectRev !== undefined && opts.expectRev !== null && !opts.force) {
    if (Number(opts.expectRev) !== currentRev) {
      fail(409, `Холст изменён вне этой сессии (ревизия ${currentRev}, ожидалась ${opts.expectRev}).`, {
        rev: currentRev,
        expected: Number(opts.expectRev),
      })
    }
  }
  const normalized = normalizeDoc(doc, canvasId)
  normalized.id = canvasId
  normalized.updatedAt = new Date().toISOString()
  const rev = currentRev + 1
  const payload = { ...normalized, rev }
  const size = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  if (size > MAX_CANVAS_BYTES) {
    fail(413, `Холст больше ${Math.round(MAX_CANVAS_BYTES / 1024 / 1024)} МБ и не читается назад. Уменьши документ (например, вложения-картинки) и повтори.`)
  }
  await mkdir(project.designPath, { recursive: true })
  await ensureProjectMeta(project.designPath, project.id, project.title)
  await writeJsonAtomic(path, payload)
  return { doc: normalized, rev, path, project }
}

/**
 * Создать холст. Существующий файл без `overwrite` — ошибка.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ name, device, overwrite, create }`.
 * @returns {Promise<{doc: object, rev: number, path: string}>}
 */
export async function createCanvas(projectRef, canvasId, opts = {}) {
  const project = await resolveProject(projectRef, { create: opts.create !== false })
  const path = canvasPath(project, canvasId)
  if (existsSync(path) && opts.overwrite !== true) {
    fail(409, `Холст «${canvasId}» уже существует в проекте «${project.id}».`)
  }
  const doc = opts.doc ?? defaultDocument(canvasId, opts.name ?? canvasId, { device: opts.device })
  return writeCanvasTo(project, canvasId, doc, { create: true, force: true })
}

/**
 * Удалить холст в восстановимую корзину `$DSH_HOME/design-trash/`.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @returns {Promise<{trashId: string, path: string}>}
 */
export async function deleteCanvas(projectRef, canvasId) {
  const project = await resolveProject(projectRef)
  const path = canvasPath(project, canvasId)
  if (!existsSync(path)) fail(404, `Холст «${canvasId}» не найден.`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trashId = `${stamp}_${project.id}_${canvasId}`
  const target = join(trashRoot(), trashId)
  await mkdir(target, { recursive: true })
  await rename(path, join(target, basename(path)))
  await writeJsonAtomic(join(target, 'meta.json'), {
    project: project.id,
    projectRoot: project.root,
    canvas: canvasId,
    deletedAt: new Date().toISOString(),
  })
  return { trashId, path: join(target, basename(path)) }
}

/**
 * Проверить метку корзины.
 *
 * Метка приходит от вызывающей стороны и склеивается с путём корзины, поэтому
 * одного регулярного выражения мало: «.» и «..» формально подходят под набор
 * допустимых символов, но выводят за пределы каталога.
 *
 * @param {string} trashId Метка записи корзины.
 */
function assertTrashId(trashId) {
  const ok = typeof trashId === 'string'
    && trashId.length > 0
    && trashId.length <= 200
    && /^[A-Za-z0-9_.-]+$/.test(trashId)
    && trashId !== '.'
    && trashId !== '..'
    && !trashId.includes('/')
    && !trashId.includes('\\')
  if (!ok) fail(400, `Недопустимая метка корзины «${trashId}».`)
}

/** Список записей корзины макетов. */
export async function listTrash() {
  if (!existsSync(trashRoot())) return []
  const entries = await readdir(trashRoot(), { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(trashRoot(), entry.name, 'meta.json')
    let meta = {}
    if (existsSync(metaPath)) {
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8'))
      } catch {
        meta = {}
      }
    }
    out.push({ trashId: entry.name, ...meta })
  }
  out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
  return out
}

/**
 * Вернуть холст из корзины.
 *
 * @param {string} trashId Метка записи корзины.
 * @param {object} [opts] `{ overwrite: boolean }`.
 * @returns {Promise<{restored: string, project: string, canvas: string}>}
 */
export async function restoreTrash(trashId, opts = {}) {
  assertTrashId(trashId)
  const dir = join(trashRoot(), trashId)
  if (!existsSync(dir)) fail(404, `Запись корзины «${trashId}» не найдена.`)
  const metaPath = join(dir, 'meta.json')
  let meta = {}
  if (existsSync(metaPath)) meta = JSON.parse(await readFile(metaPath, 'utf8'))
  const files = (await readdir(dir)).filter((name) => name.endsWith(CANVAS_EXT))
  if (files.length === 0) fail(500, `В записи корзины нет файла холста.`)
  const canvasId = meta.canvas ?? files[0].slice(0, -CANVAS_EXT.length)
  const project = await resolveProject(meta.projectRoot ?? meta.project, { create: true })
  const target = canvasPath(project, canvasId)
  if (existsSync(target) && opts.overwrite !== true) fail(409, `Холст «${canvasId}» уже существует в проекте «${project.id}».`)
  await mkdir(project.designPath, { recursive: true })
  await rename(join(dir, files[0]), target)
  await unlink(metaPath).catch(() => {})
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return { restored: canvasId, project: project.id, canvas: canvasId }
}

/**
 * Путь для экспортированного артефакта внутри проекта.
 *
 * @param {object} project Запись проекта.
 * @param {string} name Имя файла (без пути).
 * @returns {string}
 */
export function exportPath(project, name) {
  const safe = basename(name)
  return join(project.designPath, EXPORT_DIR, safe)
}

/** Записать экспортированный файл (HTML/CSS/ассет). */
export async function writeExport(project, name, content) {
  const dir = join(project.designPath, EXPORT_DIR)
  await mkdir(dir, { recursive: true })
  const path = exportPath(project, name)
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * Атомарная запись JSON: временный файл рядом, затем rename.
 *
 * В имени временного файла есть счётчик: два писателя одного пути в одну
 * миллисекунду (автосохранение панели и `design_apply`) иначе получили бы одно
 * имя, и второй `rename` упал бы сырым `ENOENT` вместо внятной ошибки.
 */
async function writeJsonAtomic(path, value) {
  tmpSeq += 1
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpSeq}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Канонический путь к конфигу реестра (для сообщений и панели). */
export function configPath() {
  return configFile()
}

/** Глубокая копия документа — реэкспорт, чтобы вызывающим был один импорт. */
export { cloneDoc }
