/**
 * Сервисный слой плагина макетов: логика поверх схемы, хранилища и экспорта.
 *
 * Единственное место, где собирается «что делает операция». Инструменты агента
 * (`tools.js`) и HTTP-маршрут панели (`route.js`) — тонкие адаптеры: они
 * разбирают аргументы и рендерят результат, но не дублируют правила.
 *
 * Каждая функция возвращает обычный JSON-объект: он одновременно и результат
 * инструмента, и тело HTTP-ответа.
 */
import {
  DEVICE_PRESETS,
  childrenOf,
  countNodes,
  defaultDocument,
  expandInstance,
  expandTree,
  flattenTokens,
  normalizeDoc,
  validateDoc,
} from './schema.js'
import { applyOps, outline } from './ops.js'
import { renderDocument } from './export.js'
import {
  StoreError,
  configPath,
  createCanvas,
  deleteCanvas,
  ensureProject,
  listCanvases,
  listProjects,
  listTrash,
  readCanvas,
  resolveProject,
  restoreTrash,
  writeCanvas,
  writeExport,
} from './store.js'

/** Реэкспорт ошибки хранилища, чтобы адаптеры ловили одну и ту же. */
export { StoreError }

/** Обёртка ошибки операций над документом. */
export class ServiceError extends Error {
  constructor(status, message, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

/**
 * Список проектов и (опционально) их холстов.
 *
 * @param {object} [opts] `{ project, canvases }`.
 * @returns {Promise<object>}
 */
export async function projectsView(opts = {}) {
  const projects = await listProjects()
  const withCanvases = opts.canvases === true || typeof opts.project === 'string'
  const selected = typeof opts.project === 'string' && opts.project !== ''
    ? await resolveProject(opts.project, { create: false })
    : null
  const out = []
  for (const project of projects) {
    const entry = { ...project }
    if (withCanvases && (project.initialized || project.canvases > 0)) {
      entry.canvasList = await listCanvases(project.id)
    }
    out.push(entry)
  }
  return {
    configPath: configPath(),
    projects: out,
    selected: selected ? { id: selected.id, title: selected.title, root: selected.root, designPath: selected.designPath } : null,
    devices: Object.keys(DEVICE_PRESETS),
    hint: 'Холсты лежат в <root>/.design/<id>.canvas.json и версионируются вместе с кодом проекта.',
  }
}

/**
 * Список холстов проекта.
 *
 * @param {string} projectRef id проекта или путь.
 * @returns {Promise<object>}
 */
export async function canvasesView(projectRef) {
  const project = await resolveProject(projectRef, { create: false })
  return {
    project: { id: project.id, title: project.title, root: project.root, designPath: project.designPath, initialized: project.initialized },
    canvases: await listCanvases(project.id),
  }
}

/**
 * Чтение холста в одной из проекций.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ mode, node, depth }`.
 * @returns {Promise<object>}
 */
export async function readView(projectRef, canvasId, opts = {}) {
  const { doc, rev, project } = await readCanvas(projectRef, canvasId)
  const mode = ['full', 'outline', 'node', 'tokens', 'components', 'summary'].includes(opts.mode) ? opts.mode : 'summary'
  const base = {
    project: project.id,
    projectRoot: project.root,
    canvas: doc.id,
    name: doc.name,
    device: doc.device,
    rev,
    updatedAt: doc.updatedAt,
    path: `${project.designPath}/${doc.id}.canvas.json`,
  }
  if (mode === 'full') return { ...base, mode, doc }
  if (mode === 'outline') return { ...base, mode, outline: outline(doc), stats: docStats(doc) }
  if (mode === 'tokens') return { ...base, mode, tokens: doc.tokens, flat: flattenTokens(doc) }
  if (mode === 'components') return { ...base, mode, components: componentSummaries(doc) }
  if (mode === 'node') {
    if (!opts.node) throw new ServiceError(400, 'Для mode=node нужен параметр «node».')
    const node = findInDoc(doc, opts.node)
    if (!node) throw new ServiceError(404, `Узел «${opts.node}» не найден.`)
    const expanded = node.type === 'instance' ? expandInstance(doc, node) : node
    return { ...base, mode, node: expanded, resolved: node.type === 'instance' }
  }
  return {
    ...base,
    mode: 'summary',
    stats: docStats(doc),
    outline: outline(doc).slice(0, Math.max(1, Number(opts.depth) || 80)),
    components: componentSummaries(doc),
  }
}

/** Сводка по документу для быстрого ответа агенту. */
function docStats(doc) {
  const report = validateDoc(doc, { contrast: false })
  return {
    ...report.stats,
    topFrames: (doc.root.children ?? []).map((node) => ({ id: node.id, name: node.name, w: node.w, h: node.h })),
    nodes: countNodes(doc.root),
  }
}

/** Компактное описание компонентов. */
function componentSummaries(doc) {
  return Object.values(doc.components ?? {}).map((component) => ({
    key: component.key,
    name: component.name,
    description: component.description,
    w: component.node?.w,
    h: component.node?.h,
    nodes: countNodes(component.node ?? {}),
    props: component.props,
    instances: countInstances(doc, component.key),
  }))
}

/** Сколько инстансов компонента в документе. */
function countInstances(doc, key) {
  let count = 0
  const stack = [doc.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.type === 'instance' && node.component === key) count += 1
    for (const child of childrenOf(doc, node)) stack.push(child)
  }
  return count
}

/** Поиск узла в документе по id. */
function findInDoc(doc, id) {
  let found = null
  const stack = [doc.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.id === id) return node
    for (const child of node.children ?? []) stack.push(child)
  }
  return found
}

/**
 * Дерево для отрисовки: инстансы развёрнуты в содержимое компонентов.
 *
 * Редактор не должен повторять правила разворачивания компонентов и
 * переопределений, поэтому он получает готовое дерево. Идентификаторы детей
 * инстанса неймспейснуты его id (`<instanceId>/<childId>`) — по префиксу
 * панель понимает, что выделять нужно сам инстанс, а не внутренний узел.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @returns {Promise<object>}
 */
export async function displayView(projectRef, canvasId) {
  const { doc, rev, project } = await readCanvas(projectRef, canvasId)
  const display = {
    ...doc.root,
    children: (doc.root.children ?? []).map((node) => expandTree(doc, node)),
  }
  return {
    project: project.id,
    canvas: doc.id,
    name: doc.name,
    device: doc.device,
    rev,
    updatedAt: doc.updatedAt,
    doc,
    display,
    components: componentSummaries(doc),
    tokens: flattenTokens(doc),
    stats: docStats(doc),
  }
}

/**
 * Создать холст.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ name, device, overwrite, template, ops }`.
 * @returns {Promise<object>}
 */
export async function createView(projectRef, canvasId, opts = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(canvasId ?? '')) {
    throw new ServiceError(400, '«canvas»: буквы, цифры, «_» и «-», до 64 символов. Например `home` или `settings-mobile`.')
  }
  let doc = opts.template === 'blank'
    ? { ...defaultDocument(canvasId, opts.name ?? canvasId, { device: opts.device }), root: { ...defaultDocument(canvasId, canvasId).root, children: [] } }
    : defaultDocument(canvasId, opts.name ?? canvasId, { device: opts.device })
  if (Array.isArray(opts.ops) && opts.ops.length > 0) {
    doc = applyOps(doc, opts.ops).doc
  }
  const { doc: saved, rev, path, project } = await createCanvas(projectRef, canvasId, {
    name: opts.name ?? canvasId,
    device: opts.device,
    overwrite: opts.overwrite === true,
    doc,
    create: true,
  })
  return {
    project: project.id,
    canvas: saved.id,
    name: saved.name,
    device: saved.device,
    rev,
    path,
    stats: docStats(saved),
    hint: 'Дальше — design_apply с операциями add/update/... или панель «Макеты» в веб-интерфейсе.',
  }
}

/**
 * Применить батч операций к холсту.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object[]} ops Операции.
 * @param {object} [opts] `{ expectRev, force, create, name }`.
 * @returns {Promise<object>}
 */
export async function applyBatch(projectRef, canvasId, ops, opts = {}) {
  const exists = await canvasExists(projectRef, canvasId)
  if (!exists && opts.create !== false) {
    const created = await createView(projectRef, canvasId, { name: opts.name ?? canvasId, create: true })
    opts = { ...opts, expectRev: created.rev }
  }
  const { doc, rev } = await readCanvas(projectRef, canvasId)
  let result
  try {
    result = applyOps(doc, ops)
  } catch (error) {
    throw new ServiceError(400, error.message, { opIndex: error.opIndex, op: error.op })
  }
  const saved = await writeCanvas(projectRef, canvasId, result.doc, {
    expectRev: opts.expectRev ?? rev,
    force: opts.force === true,
    create: true,
  })
  const report = validateDoc(saved.doc, { contrast: false })
  return {
    project: saved.project.id,
    canvas: canvasId,
    rev: saved.rev,
    applied: result.results,
    stats: { ...report.stats, nodes: countNodes(saved.doc.root) },
    issues: report.issues.filter((issue) => issue.level === 'error'),
    path: saved.path,
  }
}

/** Существует ли холст (без исключения). */
async function canvasExists(projectRef, canvasId) {
  try {
    await readCanvas(projectRef, canvasId)
    return true
  } catch (error) {
    if (error instanceof StoreError && error.status === 404) return false
    throw error
  }
}

/**
 * Экспорт холста в HTML/CSS.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ mode, frame, write, inline }`.
 * @returns {Promise<object>}
 */
export async function exportView(projectRef, canvasId, opts = {}) {
  const { doc, rev, project } = await readCanvas(projectRef, canvasId)
  const rendered = renderDocument(doc, { mode: opts.mode, frame: opts.frame, inlineCss: opts.inline === true })
  const written = []
  if (opts.write !== false) {
    for (const file of rendered.files) {
      written.push(await writeExport(project, file.name, file.content))
    }
  }
  return {
    project: project.id,
    canvas: doc.id,
    rev,
    mode: opts.mode ?? 'fidelity',
    files: rendered.files.map((file, index) => ({
      name: file.name,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      path: written[index],
    })),
    warnings: rendered.warnings,
    html: opts.inline === true ? rendered.html : undefined,
    preview: opts.preview === true ? rendered.html : undefined,
    hint: written.length > 0
      ? `Открыть ${written[0]} в браузере или положить рядом с приложением.`
      : 'Файлы не записаны (write=false).',
  }
}

/**
 * Проверка холста.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ contrast }`.
 * @returns {Promise<object>}
 */
export async function validateView(projectRef, canvasId, opts = {}) {
  const { doc, rev, project } = await readCanvas(projectRef, canvasId)
  const report = validateDoc(doc, { contrast: opts.contrast !== false })
  return { project: project.id, canvas: doc.id, rev, ...report }
}

/**
 * Чтение и правка токенов холста.
 *
 * «Заменить набор» и «удалить токены» — одна операция: удаление применяется к
 * итоговому набору, а не к прежнему, поэтому комбинация `replace` + `remove`
 * не теряет ни новых значений, ни удалений.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} [opts] `{ tokens, replace, remove, expectRev }`.
 * @returns {Promise<object>}
 */
export async function tokensView(projectRef, canvasId, opts = {}) {
  const { doc, rev } = await readCanvas(projectRef, canvasId)
  const hasWrite = (opts.tokens && Object.keys(opts.tokens).length > 0) || (Array.isArray(opts.remove) && opts.remove.length > 0)
  if (!hasWrite) {
    return { canvas: canvasId, rev, tokens: doc.tokens, flat: flattenTokens(doc), written: false }
  }
  const ops = [{
    op: 'set-tokens',
    tokens: opts.tokens,
    replace: opts.replace === true,
    remove: Array.isArray(opts.remove) ? opts.remove : [],
  }]
  const result = await applyBatch(projectRef, canvasId, ops, { expectRev: opts.expectRev ?? rev })
  const { doc: updated } = await readCanvas(projectRef, canvasId)
  return {
    canvas: canvasId,
    rev: result.rev,
    tokens: updated.tokens,
    flat: flattenTokens(updated),
    applied: result.applied,
    written: true,
  }
}

/**
 * Работа с библиотекой компонентов холста.
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} args `{ action, key, from, name, props, overrides, parent, x, y, w, h }`.
 * @returns {Promise<object>}
 */
export async function componentsView(projectRef, canvasId, args = {}) {
  const action = args.action ?? 'list'
  const { doc, rev } = await readCanvas(projectRef, canvasId)
  if (action === 'list') return { canvas: canvasId, rev, components: componentSummaries(doc), written: false }
  if (action === 'get') {
    const component = doc.components?.[args.key]
    if (!component) throw new ServiceError(404, `Компонент «${args.key}» не найден.`)
    return { canvas: canvasId, rev, component, written: false }
  }
  if (action === 'define') {
    if (!args.from) throw new ServiceError(400, 'Для action=define нужен «from» — id узла-основы.')
    const result = await applyBatch(projectRef, canvasId, [{
      op: 'define-component',
      key: args.key,
      from: args.from,
      name: args.name,
      description: args.description,
      props: args.props,
      convert: args.convert !== false,
    }], { expectRev: args.expectRev ?? rev })
    return { canvas: canvasId, rev: result.rev, applied: result.applied, written: true }
  }
  if (action === 'delete') {
    const result = await applyBatch(projectRef, canvasId, [{
      op: 'delete-component',
      key: args.key,
      detach: args.detach !== false,
    }], { expectRev: args.expectRev ?? rev })
    return { canvas: canvasId, rev: result.rev, applied: result.applied, written: true }
  }
  if (action === 'instantiate') {
    const result = await applyBatch(projectRef, canvasId, [{
      op: 'instantiate',
      component: args.key,
      parent: args.parent ?? 'root',
      x: args.x,
      y: args.y,
      w: args.w,
      h: args.h,
      overrides: args.overrides,
    }], { expectRev: args.expectRev ?? rev })
    return { canvas: canvasId, rev: result.rev, applied: result.applied, written: true }
  }
  if (action === 'detach') {
    if (!args.from) throw new ServiceError(400, 'Для action=detach нужен «from» — id инстанса.')
    const result = await applyBatch(projectRef, canvasId, [{ op: 'detach', id: args.from }], { expectRev: args.expectRev ?? rev })
    return { canvas: canvasId, rev: result.rev, applied: result.applied, written: true }
  }
  throw new ServiceError(400, `Неизвестное действие «${action}»: list | get | define | delete | instantiate | detach.`)
}

/**
 * Удалить холст (в корзину) или вернуть его из корзины.
 *
 * @param {object} args `{ action, project, canvas, trashId, overwrite }`.
 * @returns {Promise<object>}
 */
export async function trashView(args = {}) {
  const action = args.action ?? 'list'
  if (action === 'list') return { action, entries: await listTrash() }
  if (action === 'delete') {
    if (!args.canvas) throw new ServiceError(400, 'Для action=delete нужен «canvas».')
    const result = await deleteCanvas(args.project, args.canvas)
    return { action, canvas: args.canvas, ...result }
  }
  if (action === 'restore') {
    if (!args.trashId) throw new ServiceError(400, 'Для action=restore нужен «trashId».')
    const result = await restoreTrash(args.trashId, { overwrite: args.overwrite === true })
    return { action, ...result }
  }
  throw new ServiceError(400, `Неизвестное действие «${action}»: list | delete | restore.`)
}

/**
 * Инициализировать проект: создать `<root>/.design/` и зарегистрировать корень.
 *
 * @param {string} root Каталог проекта.
 * @param {string} [title] Отображаемое имя.
 * @returns {Promise<object>}
 */
export async function initProjectView(root, title) {
  const project = await ensureProject(root, title)
  return { project: { id: project.id, title: project.title, root: project.root, designPath: project.designPath }, initialized: true }
}

/**
 * Записать документ целиком (панель сохраняет состояние редактора).
 *
 * @param {string} projectRef id проекта или путь.
 * @param {string} canvasId id холста.
 * @param {object} doc Документ.
 * @param {object} [opts] `{ expectRev, force }`.
 * @returns {Promise<object>}
 */
export async function writeDocView(projectRef, canvasId, doc, opts = {}) {
  const normalized = normalizeDoc(doc, canvasId)
  const saved = await writeCanvas(projectRef, canvasId, normalized, {
    expectRev: opts.expectRev,
    force: opts.force === true,
    create: true,
  })
  const report = validateDoc(saved.doc, { contrast: false })
  return {
    project: saved.project.id,
    canvas: canvasId,
    rev: saved.rev,
    path: saved.path,
    stats: report.stats,
    issues: report.issues.filter((issue) => issue.level === 'error'),
  }
}
