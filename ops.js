/**
 * Операции над документом макета.
 *
 * Один набор операций обслуживает двух вызывающих:
 *  - инструмент агента `design_apply` (и остальные `design_*`);
 *  - HTTP-маршрут панели `/api/dsh-design-canvas`.
 *
 * Операции применяются транзакционно: батч идёт в копию документа, и любая
 * ошибка откатывает весь батч. Агент, написавший десять шагов и ошибшийся на
 * девятом, не оставляет после себя полусобранный макет.
 *
 * Формат операции — `{ op: 'update', id: 'n_1', patch: { x: 40 } }`. Полный
 * список и семантика — в README.md и в описании инструмента `design_apply`.
 */
import {
  CONTAINER_TYPES,
  DEVICE_PRESETS,
  NODE_TYPES,
  childrenOf,
  cloneDoc,
  componentTemplate,
  defaultNode,
  expandInstance,
  findNode,
  findParent,
  firstText,
  isPlainObject,
  layoutChildren,
  mergeNodePatch,
  newId,
  normalizeComponent,
  normalizeDoc,
  normalizeGuides,
  normalizeNode,
  num,
  walk,
} from './schema.js'

/** Ошибка операции: несёт индекс операции в батче. */
export class OpsError extends Error {
  constructor(message, opIndex, op) {
    super(message)
    this.opIndex = opIndex
    this.op = op
  }
}

function fail(message, index, op) {
  throw new OpsError(message, index, op)
}

/** Все имена операций, которые понимает движок. */
export const OPS = [
  'add', 'update', 'move', 'delete', 'duplicate', 'group', 'ungroup', 'reorder',
  'set-tokens', 'define-component', 'update-component', 'delete-component', 'instantiate', 'detach',
  'set-canvas', 'align', 'distribute', 'set-guides',
]

/**
 * Применить батч операций к документу.
 *
 * @param {object} doc Исходный документ (не мутируется).
 * @param {object[]} ops Операции.
 * @param {object} [opts] `{ relayout: boolean }` — пересчёт потоковых фреймов.
 * @returns {{doc: object, results: object[]}} Новый документ и отчёт по операциям.
 */
export function applyOps(doc, ops, opts = {}) {
  const list = Array.isArray(ops) ? ops : [ops]
  if (list.length === 0) fail('Пустой список операций.', 0, null)
  if (list.length > 2000) fail('Слишком много операций в одном батче (предел 2000).', 0, null)
  const draft = cloneDoc(normalizeDoc(doc, doc?.id ?? 'canvas'))
  const results = []
  list.forEach((op, index) => {
    if (!isPlainObject(op) || typeof op.op !== 'string') fail('Операция должна быть объектом с полем «op».', index, op)
    if (!OPS.includes(op.op)) fail(`Неизвестная операция «${op.op}». Доступны: ${OPS.join(', ')}.`, index, op)
    let result
    try {
      result = applyOne(draft, op)
    } catch (error) {
      if (error instanceof OpsError) fail(`Операция ${index + 1} (${op.op}): ${error.message}`, index, op)
      fail(`Операция ${index + 1} (${op.op}): ${error.message}`, index, op)
    }
    results.push({ index, op: op.op, ...result })
  })
  if (opts.relayout !== false) relayout(draft)
  draft.updatedAt = new Date().toISOString()
  return { doc: draft, results }
}

/** Диспетчер одной операции. */
function applyOne(doc, op) {
  switch (op.op) {
    case 'add': return opAdd(doc, op)
    case 'update': return opUpdate(doc, op)
    case 'move': return opMove(doc, op)
    case 'delete': return opDelete(doc, op)
    case 'duplicate': return opDuplicate(doc, op)
    case 'group': return opGroup(doc, op)
    case 'ungroup': return opUngroup(doc, op)
    case 'reorder': return opReorder(doc, op)
    case 'set-tokens': return opSetTokens(doc, op)
    case 'define-component': return opDefineComponent(doc, op)
    case 'update-component': return opUpdateComponent(doc, op)
    case 'delete-component': return opDeleteComponent(doc, op)
    case 'instantiate': return opInstantiate(doc, op)
    case 'detach': return opDetach(doc, op)
    case 'set-canvas': return opSetCanvas(doc, op)
    case 'align': return opAlign(doc, op)
    case 'distribute': return opDistribute(doc, op)
    case 'set-guides': return opSetGuides(doc, op)
    default: fail(`Операция «${op.op}» не реализована.`)
  }
}

// ------------------------------------------------------------------- nodes ----

/** `add` — добавить узел в контейнер. */
function opAdd(doc, op) {
  const parent = requireContainer(doc, op.parent)
  const raw = isPlainObject(op.node) ? op.node : { type: typeof op.node === 'string' ? op.node : op.type }
  if (!NODE_TYPES.includes(raw.type)) fail(`Неизвестный тип узла «${raw.type ?? '—'}». Доступны: ${NODE_TYPES.join(', ')}.`)
  const node = normalizeNode({
    ...raw,
    id: raw.id && !findNode(doc.root, raw.id) ? raw.id : newId(prefixFor(raw.type)),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    // Фрейм, добавленный без явного «clip», ведёт себя как фрейм из
    // `defaultNode` и из шаблона устройства, а не как прозрачный контейнер.
    clip: raw.clip !== undefined ? raw.clip : raw.type === 'frame',
  })
  if (findNode(doc.root, node.id)) fail(`id «${node.id}» уже занят.`)
  insertAt(parent, node, op.index, op.after)
  return { id: node.id }
}

/** `update` — слить патч в один или несколько узлов. */
function opUpdate(doc, op) {
  const ids = collectIds(op)
  if (ids.length === 0) fail('Нужен «id» или «ids».')
  const patch = isPlainObject(op.patch) ? op.patch : {}
  for (const id of ids) {
    const node = requireNode(doc, id)
    mergeNodePatch(node, patch)
    if (patch.w !== undefined) node.w = Math.max(0, num(patch.w, node.w))
    if (patch.h !== undefined) node.h = Math.max(0, num(patch.h, node.h))
  }
  return { ids }
}

/** `move` — сменить родителя и/или позицию в списке. */
function opMove(doc, op) {
  const node = requireNode(doc, op.id)
  const parent = op.parent === undefined
    ? requireNode(doc, findParent(doc.root, op.id)?.id ?? 'root')
    : requireContainer(doc, op.parent)
  if (parent.id === node.id) fail('Узел не может стать родителем сам себе.')
  if (isDescendant(node, parent.id)) fail(`Узел «${parent.name}» находится внутри «${node.name}» — перемещение создало бы цикл.`)
  const from = findParent(doc.root, node.id)
  if (from) from.children = from.children.filter((child) => child.id !== node.id)
  insertAt(parent, node, op.index, op.after)
  return { id: node.id, parent: parent.id }
}

/** `delete` — удалить узлы поддерева. */
function opDelete(doc, op) {
  const ids = collectIds(op)
  if (ids.length === 0) fail('Нужен «id» или «ids».')
  for (const id of ids) {
    if (id === 'root') fail('Корень документа удалить нельзя.')
    const parent = findParent(doc.root, id)
    if (!parent) fail(`Узел «${id}» не найден.`)
    parent.children = parent.children.filter((child) => child.id !== id)
  }
  return { ids }
}

/** `duplicate` — копия поддерева рядом с оригиналом. */
function opDuplicate(doc, op) {
  const ids = collectIds(op)
  const count = Math.min(Math.max(1, num(op.count, 1)), 100)
  const out = []
  for (const id of ids) {
    const source = requireNode(doc, id)
    const parent = op.parent ? requireNode(doc, op.parent) : findParent(doc.root, id)
    if (!parent) fail(`Узел «${id}» не найден.`)
    for (let i = 0; i < count; i += 1) {
      const copy = JSON.parse(JSON.stringify(source))
      reid(copy)
      copy.name = `${source.name} copy${count > 1 ? ` ${i + 1}` : ''}`
      copy.x = num(copy.x, 0) + num(op.offsetX, 24) * (i + 1)
      copy.y = num(copy.y, 0) + num(op.offsetY, 24) * (i + 1)
      const anchorIndex = parent.children.findIndex((child) => child.id === source.id)
      if (anchorIndex >= 0) parent.children.splice(anchorIndex + 1 + i, 0, copy)
      else parent.children.push(copy)
      out.push(copy.id)
    }
  }
  return { ids: out }
}

/** `group` — обернуть выделение в группу или фрейм (по общему bounding box). */
function opGroup(doc, op) {
  const ids = Array.isArray(op.ids) ? op.ids : []
  if (ids.length < 1) fail('Для group нужен список «ids».')
  if (op.as !== undefined && op.as !== 'group' && op.as !== 'frame') {
    fail(`Неизвестный «as»: ${op.as}. Допустимо group или frame.`)
  }
  const kind = op.as === 'frame' ? 'frame' : 'group'
  const nodes = ids.map((id) => requireNode(doc, id))
  const parent = findParent(doc.root, nodes[0].id)
  if (!parent) fail('Не найден общий родитель для группировки.')
  for (const node of nodes) {
    if (findParent(doc.root, node.id)?.id !== parent.id) {
      fail('Все узлы группы должны лежать в одном родителе.')
    }
  }
  const minX = Math.min(...nodes.map((node) => num(node.x, 0)))
  const minY = Math.min(...nodes.map((node) => num(node.y, 0)))
  const maxX = Math.max(...nodes.map((node) => num(node.x, 0) + num(node.w, 0)))
  const maxY = Math.max(...nodes.map((node) => num(node.y, 0) + num(node.h, 0)))
  const group = defaultNode(kind, {
    name: op.name ?? (kind === 'frame' ? 'Frame' : 'Group'),
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  })
  const order = parent.children.map((child) => child.id)
  const insertIndex = Math.min(...nodes.map((node) => order.indexOf(node.id)).filter((i) => i >= 0))
  parent.children = parent.children.filter((child) => !ids.includes(child.id))
  for (const node of nodes) {
    node.x = num(node.x, 0) - minX
    node.y = num(node.y, 0) - minY
    group.children.push(node)
  }
  parent.children.splice(Math.max(0, insertIndex), 0, group)
  return { id: group.id, children: ids }
}

/** `ungroup` — развернуть группу, вернув детей родителю. */
function opUngroup(doc, op) {
  const node = requireNode(doc, op.id)
  // У инстанса нет собственных детей, поэтому ветка «пустая группа» удалила бы
  // его из дерева — то есть молча потеряла бы узел вместо разгруппировки.
  if (node.type === 'instance') fail(`Узел «${node.name}» — инстанс компонента, а не группа. Используй detach.`)
  const parent = findParent(doc.root, node.id)
  if (!parent) fail('Корень разгруппировать нельзя.')
  if (!Array.isArray(node.children) || node.children.length === 0) {
    parent.children = parent.children.filter((child) => child.id !== node.id)
    return { ids: [] }
  }
  const index = parent.children.findIndex((child) => child.id === node.id)
  const moved = []
  for (const child of node.children) {
    child.x = num(child.x, 0) + num(node.x, 0)
    child.y = num(child.y, 0) + num(node.y, 0)
    moved.push(child.id)
  }
  parent.children.splice(index, 1, ...node.children)
  return { ids: moved }
}

/** `reorder` — переставить узел внутри родителя. */
function opReorder(doc, op) {
  const node = requireNode(doc, op.id)
  const parent = findParent(doc.root, node.id)
  if (!parent) fail('Корень переставить нельзя.')
  const siblings = parent.children
  const from = siblings.findIndex((child) => child.id === node.id)
  siblings.splice(from, 1)
  let to
  if (typeof op.index === 'number') to = Math.max(0, Math.min(siblings.length, op.index))
  else if (op.direction === 'front') to = siblings.length
  else if (op.direction === 'back') to = 0
  else if (op.direction === 'up') to = Math.min(siblings.length, from + 1)
  else if (op.direction === 'down') to = Math.max(0, from - 1)
  else fail('Нужен «index» или «direction»: front | back | up | down.')
  siblings.splice(to, 0, node)
  return { id: node.id, index: to }
}

// ------------------------------------------------------------------ tokens ----

/** `set-tokens` — слить (или заменить) набор токенов и удалить перечисленные пути. */
function opSetTokens(doc, op) {
  const tokens = isPlainObject(op.tokens) ? op.tokens : {}
  const remove = Array.isArray(op.remove) ? op.remove.filter((path) => typeof path === 'string' && path !== '') : []
  if (Object.keys(tokens).length === 0 && remove.length === 0) fail('Нужен объект «tokens» или список «remove».')
  const next = op.replace === true ? {} : { ...(doc.tokens ?? {}) }
  for (const [group, values] of Object.entries(tokens)) {
    if (!isPlainObject(values)) {
      next[group] = values
      continue
    }
    next[group] = { ...(next[group] ?? {}), ...values }
  }
  for (const path of remove) removeTokenPath(next, path)
  // Пустой набор не представим в модели: `normalizeTokens` заменит его
  // значениями по умолчанию, то есть «удали всё» вернуло бы палитру молча.
  if (Object.keys(next).length === 0) fail('Набор токенов не может стать пустым: оставь хотя бы одну группу.')
  doc.tokens = next
  return { groups: Object.keys(tokens), removed: remove.length }
}

/**
 * Удалить путь токена из набора: группа (`color`), значение (`color.bg`)
 * или поле составного токена (`text.h1.size`). Отсутствующий путь — не ошибка.
 */
function removeTokenPath(tokens, path) {
  const [group, name, ...sub] = String(path).split('.')
  if (!group) return
  if (name === undefined) {
    delete tokens[group]
    return
  }
  if (sub.length === 0) {
    if (isPlainObject(tokens[group])) delete tokens[group][name]
    return
  }
  const composite = tokens[group]?.[name]
  if (isPlainObject(composite)) delete composite[sub.join('.')]
}

// -------------------------------------------------------------- components ----

/**
 * `define-component` — превратить узел в компонент.
 *
 * По умолчанию исходный узел становится инстансом нового компонента (как
 * «Create component» в Figma). `convert: false` оставляет исходный узел как
 * есть — режим «библиотека» для агента, собирающего набор компонентов.
 */
function opDefineComponent(doc, op) {
  const key = typeof op.key === 'string' && op.key !== '' ? op.key : null
  if (!key) fail('Нужен «key» компонента.')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) fail('«key» компонента: буквы, цифры, «_», «-», до 64 символов.')
  // Шаблон можно взять из узла холста (`from`) или задать напрямую (`node`):
  // второе нужно панели, чтобы клонировать компонент, не ставя его на холст.
  if (op.node !== undefined && !isPlainObject(op.node)) fail('«node» — объект-шаблон узла.')
  if (op.node === undefined && !op.from) fail('Нужен «from» (id узла-основы) или «node» (готовый шаблон).')
  const source = op.node === undefined ? requireNode(doc, op.from) : null
  if (source && source.id === 'root') fail('Корень холста не может быть компонентом — возьми фрейм внутри него.')
  const template = JSON.parse(JSON.stringify(source ?? op.node))
  template.x = 0
  template.y = 0
  reid(template)
  const props = isPlainObject(op.props) ? op.props : inferProps(template)
  const component = normalizeComponent(key, {
    key,
    name: op.name ?? source?.name ?? template.name ?? key,
    description: op.description ?? '',
    node: template,
    props,
  })
  doc.components[key] = component
  if (source && op.convert !== false) {
    const instance = defaultNode('instance', {
      id: source.id,
      name: component.name,
      x: num(source.x, 0),
      y: num(source.y, 0),
      w: num(source.w, 0),
      h: num(source.h, 0),
      component: key,
      overrides: {},
    })
    const parent = findParent(doc.root, source.id)
    if (parent) {
      const index = parent.children.findIndex((child) => child.id === source.id)
      parent.children.splice(index, 1, instance)
    }
  }
  return { key, props: Object.keys(component.props) }
}

/**
 * `update-component` — правка существующего компонента без пересоздания.
 *
 * `define-component` перезаписывает ключ целиком и молча теряет прежний шаблон,
 * поэтому правка имени, описания и параметров идёт отдельной операцией. `props`
 * сливаются по имени параметра, а сам параметр — по полям (как патч в
 * `update`): `{ label: { default: 'ОК' } }` меняет только значение по умолчанию и
 * не теряет `target`. Значение `null` убирает параметр, `node` заменяет шаблон
 * целиком. Собранный компонент проходит `normalizeComponent`,
 * то есть мусор в типах и `target` чинится теми же правилами, что при объявлении.
 */
function opUpdateComponent(doc, op) {
  const key = op.key
  const component = doc.components?.[key]
  if (!component) fail(`Компонент «${key}» не найден.`)
  if (op.name !== undefined && (typeof op.name !== 'string' || op.name === '')) {
    fail('«name» компонента — непустая строка.')
  }
  if (op.description !== undefined && typeof op.description !== 'string') {
    fail('«description» компонента — строка.')
  }
  if (op.props !== undefined && !isPlainObject(op.props)) fail('«props» — объект параметров.')
  if (op.variants !== undefined && !isPlainObject(op.variants)) fail('«variants» — объект вариаций.')
  if (op.node !== undefined && !isPlainObject(op.node)) fail('«node» — объект-шаблон узла.')
  const props = { ...component.props }
  for (const [name, spec] of Object.entries(op.props ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(`Имя параметра «${name}»: буквы, цифры, «_», «-», до 64 символов.`)
    if (spec === null) delete props[name]
    else if (isPlainObject(spec)) props[name] = { ...(isPlainObject(props[name]) ? props[name] : {}), ...spec }
    else fail(`Параметр «${name}» — объект или null.`)
  }
  const variants = { ...component.variants }
  for (const [name, spec] of Object.entries(op.variants ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail(`Имя вариации «${name}»: буквы, цифры, «_», «-», до 64 символов.`)
    if (spec === null) {
      delete variants[name]
      continue
    }
    if (!isPlainObject(spec)) fail(`Вариация «${name}» — объект или null.`)
    const current = isPlainObject(variants[name]) ? variants[name] : {}
    const next = { ...current, ...spec }
    if (isPlainObject(current.props) && isPlainObject(spec.props)) next.props = { ...current.props, ...spec.props }
    variants[name] = next
  }
  doc.components[key] = normalizeComponent(key, {
    name: op.name ?? component.name,
    description: op.description ?? component.description,
    node: op.node ?? component.node,
    props,
    variants,
  })
  return {
    key,
    name: doc.components[key].name,
    props: Object.keys(doc.components[key].props),
    variants: Object.keys(doc.components[key].variants),
  }
}

/** `delete-component` — убрать компонент; инстансы либо детач, либо ломаются. */
function opDeleteComponent(doc, op) {
  const key = op.key
  if (!doc.components?.[key]) fail(`Компонент «${key}» не найден.`)
  const instances = []
  walk(doc.root, (node) => {
    if (node.type === 'instance' && node.component === key) instances.push(node)
  })
  if (op.detach !== false) {
    for (const instance of instances) detachInPlace(doc, instance)
  }
  delete doc.components[key]
  return { key, detached: op.detach !== false ? instances.length : 0 }
}

/** `instantiate` — поставить инстанс компонента. */
function opInstantiate(doc, op) {
  const key = op.component
  const component = doc.components?.[key]
  if (!component) fail(`Компонент «${key}» не найден.`)
  const parent = requireContainer(doc, op.parent)
  // Размер берётся из шаблона вариации: у «большой» и «малой» кнопки он разный.
  const template = componentTemplate(component, op.variant)
  const instance = defaultNode('instance', {
    name: op.name ?? component.name,
    x: num(op.x, 0),
    y: num(op.y, 0),
    w: num(op.w, num(template.w, 100)),
    h: num(op.h, num(template.h, 100)),
    component: key,
    variant: typeof op.variant === 'string' && op.variant !== '' ? op.variant : undefined,
    overrides: isPlainObject(op.overrides) ? op.overrides : {},
  })
  insertAt(parent, instance, op.index, op.after)
  return { id: instance.id, component: key, variant: instance.variant }
}

/** `detach` — заменить инстанс обычным узлом с развёрнутым содержимым. */
function opDetach(doc, op) {
  const node = requireNode(doc, op.id)
  if (node.type !== 'instance') fail(`Узел «${node.name}» не является инстансом.`)
  const id = detachInPlace(doc, node)
  return { id }
}

/** Материализовать инстанс на месте: вернуть id нового узла. */
function detachInPlace(doc, instance) {
  const expanded = expandInstance(doc, instance)
  const plain = normalizeNode({
    ...expanded,
    id: instance.id,
    type: expanded.type === 'instance' ? 'frame' : expanded.type,
    x: num(instance.x, 0),
    y: num(instance.y, 0),
    w: num(instance.w, num(expanded.w, 100)),
    h: num(instance.h, num(expanded.h, 100)),
    component: undefined,
    instanceOf: undefined,
    missing: undefined,
  })
  delete plain.component
  delete plain.instanceOf
  const parent = findParent(doc.root, instance.id)
  if (!parent) return instance.id
  const index = parent.children.findIndex((child) => child.id === instance.id)
  parent.children.splice(index, 1, plain)
  return plain.id
}

// ------------------------------------------------------------- canvas/misc ----

/** `set-canvas` — имя и устройство холста. */
function opSetCanvas(doc, op) {
  if (typeof op.name === 'string' && op.name !== '') doc.name = op.name
  if (op.device !== undefined) {
    // Иначе неизвестное значение молча станет `mobile` при следующей
    // нормализации, и агент не узнает, что устройство не применилось.
    if (typeof op.device !== 'string' || !DEVICE_PRESETS[op.device]) {
      fail(`«device»: ${Object.keys(DEVICE_PRESETS).join(' | ')}.`)
    }
    doc.device = op.device
  }
  return { id: doc.id, name: doc.name, device: doc.device }
}

/**
 * `set-guides` — задать направляющие холста.
 *
 * `x`/`y` заменяют свою ось целиком, а не дополняют её: агент получает
 * предсказуемый результат без чтения текущего состояния, а панель и так
 * считает список локально. `clear: true` убирает разметку вовсе — поле
 * исчезает из файла, как и у холста, который направляющих не знал.
 *
 * @param {object} doc Документ (мутируется).
 * @param {object} op Операция.
 * @returns {{x: number, y: number}} Сколько направляющих осталось на каждой оси.
 */
function opSetGuides(doc, op) {
  if (op.clear === true && op.x === undefined && op.y === undefined) {
    delete doc.guides
    return { x: 0, y: 0 }
  }
  for (const axis of ['x', 'y']) {
    if (op[axis] === undefined) continue
    if (!Array.isArray(op[axis])) fail(`«${axis}» направляющих — массив координат.`)
    for (const value of op[axis]) {
      if (num(value, null) === null) fail(`Координата направляющей «${String(value)}» — не число.`)
    }
  }
  const current = normalizeGuides(doc.guides)
  const guides = normalizeGuides({
    x: op.x === undefined ? current.x : op.x,
    y: op.y === undefined ? current.y : op.y,
  })
  if (guides.x.length === 0 && guides.y.length === 0) delete doc.guides
  else doc.guides = guides
  return { x: guides.x.length, y: guides.y.length }
}

/** `align` — выровнять узлы внутри их родителя. */
function opAlign(doc, op) {
  const ids = Array.isArray(op.ids) ? op.ids : []
  if (ids.length < 2) fail('Для align нужно минимум два узла в «ids».')
  const mode = op.mode
  const rawAxis = op.axis
  if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode)) {
    fail('«mode»: left | center | right | top | middle | bottom.')
  }
  if (rawAxis !== undefined && rawAxis !== null && rawAxis !== 'x' && rawAxis !== 'y') fail('«axis»: x | y.')
  const axis = rawAxis === 'x' || rawAxis === 'y' ? rawAxis : undefined
  const modeAxis = ['left', 'center', 'right'].includes(mode) ? 'x' : 'y'
  if (axis !== undefined && axis !== modeAxis) {
    fail(`«axis»: ${axis} противоречит «mode»: ${mode} — выравнивание идёт по ${modeAxis === 'x' ? 'горизонтали' : 'вертикали'}.`)
  }
  const nodes = ids.map((id) => requireNode(doc, id))
  const parent = findParent(doc.root, nodes[0].id)
  if (!parent) fail('Не найден родитель для выравнивания.')
  const bounds = ids.map((id) => absIn(doc, id))
  if (modeAxis === 'x') {
    const left = Math.min(...bounds.map((b) => b.x))
    const right = Math.max(...bounds.map((b) => b.x + b.w))
    for (const node of nodes) {
      const b = absIn(doc, node.id)
      const delta = mode === 'left' ? left - b.x : mode === 'right' ? right - (b.x + b.w) : (left + right) / 2 - (b.x + b.w / 2)
      node.x = num(node.x, 0) + delta
    }
  } else {
    const top = Math.min(...bounds.map((b) => b.y))
    const bottom = Math.max(...bounds.map((b) => b.y + b.h))
    for (const node of nodes) {
      const b = absIn(doc, node.id)
      const delta = mode === 'top' ? top - b.y : mode === 'bottom' ? bottom - (b.y + b.h) : (top + bottom) / 2 - (b.y + b.h / 2)
      node.y = num(node.y, 0) + delta
    }
  }
  return { ids }
}

/** `distribute` — равные промежутки между узлами по оси. */
function opDistribute(doc, op) {
  const ids = Array.isArray(op.ids) ? op.ids : []
  if (ids.length < 3) fail('Для distribute нужно минимум три узла.')
  const rawAxis = op.axis
  if (rawAxis !== undefined && rawAxis !== null && rawAxis !== 'x' && rawAxis !== 'y') fail('«axis»: x | y.')
  const horizontal = rawAxis !== 'y'
  const entries = ids.map((id) => ({ id, node: requireNode(doc, id), rect: absIn(doc, id) }))
  entries.sort((a, b) => (horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y))
  const first = entries[0].rect
  const last = entries[entries.length - 1].rect
  const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y
  const total = entries.reduce((sum, entry) => sum + (horizontal ? entry.rect.w : entry.rect.h), 0)
  const gap = (span - total) / (entries.length - 1)
  let cursor = horizontal ? first.x : first.y
  for (const entry of entries) {
    const current = horizontal ? entry.rect.x : entry.rect.y
    const delta = cursor - current
    if (horizontal) entry.node.x = num(entry.node.x, 0) + delta
    else entry.node.y = num(entry.node.y, 0) + delta
    cursor += (horizontal ? entry.rect.w : entry.rect.h) + gap
  }
  return { ids, gap: Math.round(gap * 100) / 100 }
}

// ----------------------------------------------------------------- helpers ----

/** Абсолютная позиция узла внутри документа. */
function absIn(doc, id) {
  const chain = []
  let current = findNode(doc.root, id)
  while (current) {
    chain.unshift(current)
    current = findParent(doc.root, current.id)
  }
  let x = 0
  let y = 0
  for (const node of chain) {
    x += num(node.x, 0)
    y += num(node.y, 0)
  }
  const last = chain[chain.length - 1] ?? { w: 0, h: 0 }
  return { x, y, w: num(last.w, 0), h: num(last.h, 0) }
}

/** Найти узел или упасть с понятным сообщением. */
function requireNode(doc, id) {
  if (typeof id !== 'string' || id === '') fail('Не указан id узла.')
  const node = findNode(doc.root, id)
  if (!node) fail(`Узел «${id}» не найден.`)
  return node
}

/**
 * Найти контейнер, в который можно положить ребёнка.
 *
 * Проверка одна на все операции с родителем: узел не-контейнера теряет детей
 * при следующей нормализации, а инстанс — ссылка на шаблон, и его содержимое
 * живёт в компоненте, поэтому и то и другое лучше отклонить с объяснением.
 */
function requireContainer(doc, ref) {
  const parent = requireNode(doc, ref ?? 'root')
  if (!CONTAINER_TYPES.has(parent.type)) fail(`Узел «${parent.name}» (${parent.type}) не может содержать детей.`)
  if (parent.type === 'instance') fail(`Узел «${parent.name}» — инстанс компонента: его содержимое живёт в шаблоне. Сначала detach.`)
  return parent
}

/** Собрать список id из `id` / `ids`. */
function collectIds(op) {
  if (Array.isArray(op.ids)) return op.ids.filter((id) => typeof id === 'string')
  if (typeof op.id === 'string' && op.id !== '') return [op.id]
  return []
}

/** Вставить узел в контейнер с учётом `index` / `after`. */
function insertAt(parent, node, index, after) {
  const children = parent.children ?? (parent.children = [])
  let at = children.length
  if (typeof index === 'number') at = Math.max(0, Math.min(children.length, index))
  else if (typeof after === 'string') {
    const found = children.findIndex((child) => child.id === after)
    if (found >= 0) at = found + 1
  }
  children.splice(at, 0, node)
  return at
}

/** Проверка «узел находится внутри поддерева с данным id». */
function isDescendant(node, ancestorId) {
  let found = false
  walk(node, (child) => {
    if (child.id === ancestorId) found = true
  })
  return found
}

/** Переприсвоить id всем узлам поддерева. */
function reid(node) {
  node.id = newId(prefixFor(node.type))
  for (const child of node.children ?? []) reid(child)
}

/** Читаемый префикс id по типу узла. */
function prefixFor(type) {
  return { frame: 'fr', text: 'tx', rect: 'rc', ellipse: 'el', line: 'ln', image: 'im', group: 'gr', instance: 'in' }[type] ?? 'n'
}

/**
 * Автовывод параметров компонента: первый текстовый узел становится `label`.
 *
 * Нужен, чтобы агент мог объявить компонент без ручного описания параметров,
 * а инстанс — переопределить подпись одной строкой.
 */
function inferProps(template) {
  const text = firstText(template)
  if (!text) return {}
  const target = text.name && text.name !== template.name ? `#${text.name}` : 'text'
  return {
    label: {
      type: 'text',
      default: text.text?.value ?? '',
      description: 'Текст подписи',
      target,
      property: 'text.value',
    },
  }
}

/**
 * Пересчитать потоковые фреймы снизу вверх.
 *
 * Свободные фреймы (`layout.mode === 'none'`) не трогаются: их дети сохраняют
 * авторские `x`/`y`. Фреймы в потоке получают позиции от `layoutChildren`.
 *
 * @param {object} doc Документ (мутируется).
 * @returns {object} Тот же документ.
 */
export function relayout(doc) {
  const frames = []
  walk(doc.root, (node, _parent, depth) => {
    if (node.type === 'frame' && node.layout?.mode && node.layout.mode !== 'none') {
      frames.push({ node, depth })
    }
  })
  frames.sort((a, b) => b.depth - a.depth)
  for (const { node } of frames) layoutChildren(node, { autoSize: true })
  return doc
}

/**
 * Плоский список узлов документа для панели: id, тип, имя, родитель, глубина.
 *
 * Инстансы попадают в список как один узел — их внутренность принадлежит
 * компоненту, а не документу.
 *
 * @param {object} doc Документ.
 * @returns {Array<object>}
 */
export function outline(doc) {
  const out = []
  walk(doc.root, (node, parent, depth) => {
    if (node === doc.root) return
    out.push({
      id: node.id,
      type: node.type,
      name: node.name,
      parent: parent?.id ?? 'root',
      depth,
      x: num(node.x, 0),
      y: num(node.y, 0),
      w: num(node.w, 0),
      h: num(node.h, 0),
      visible: node.visible !== false,
      locked: node.locked === true,
      component: node.component,
      children: Array.isArray(node.children) ? node.children.length : 0,
      expanded: node.type === 'instance' ? childrenOf(doc, node).length : 0,
    })
  })
  return out
}
