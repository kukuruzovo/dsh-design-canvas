/**
 * HTTP-маршрут панели макетов: `/api/dsh-design-canvas`.
 *
 * Маршрут обслуживает визуальный редактор и отдаёт ровно те же операции, что и
 * инструменты агента: он вызывает `service.js`, а не повторяет его правила.
 * Формат — простой REST поверх JSON: `GET /canvases?project=…`,
 * `POST /apply`, `POST /canvas`, `GET /export`.
 *
 * Ошибки сервиса несут HTTP-статус (`StoreError.status`), поэтому клиент
 * различает 404 «нет холста», 409 «ревизия устарела» и 400 «плохая операция».
 */
import {
  applyBatch,
  canvasesView,
  componentsView,
  createView,
  displayView,
  exportView,
  initProjectView,
  projectsView,
  readView,
  tokensView,
  trashView,
  validateView,
  writeDocView,
} from './service.js'

/** Префикс маршрута панели макетов. */
export const DESIGN_ROUTE = '/api/dsh-design-canvas'

/** Предел JSON-тела: документ макета целиком приходит этим путём. */
const MAX_JSON_BYTES = 16 * 1024 * 1024

/** Отказ с HTTP-статусом. */
function fail(status, message, payload) {
  const error = new Error(message)
  error.status = status
  error.payload = payload
  throw error
}

/** Прочитать тело запроса с ограничением размера. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let stopped = false
    req.on('data', (chunk) => {
      if (stopped) return
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        // Сокет здесь не рвём: `req.destroy()` убивает соединение раньше ответа,
        // и клиент вместо обещанного 413 получает ECONNRESET. Дочитанный хвост
        // тела Node отбрасывает сам после `res.end()`.
        stopped = true
        req.pause()
        reject(Object.assign(new Error('Тело запроса слишком большое.'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/** Разобрать JSON-тело. */
async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    fail(400, 'Тело запроса — не корректный JSON.')
  }
}

/** Привести значение из query к булеву. */
function bool(value) {
  return value === '1' || value === 'true' || value === true
}

/**
 * Собрать обработчик маршрута.
 *
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createDesignHandler() {
  const routes = {
    'GET /projects': async (query) => projectsView({
      project: query.project,
      canvases: bool(query.canvases),
    }),
    'GET /canvases': async (query) => canvasesView(query.project),
    'GET /canvas': async (query) => readView(query.project, query.id ?? query.canvas, {
      mode: query.mode ?? 'full',
      node: query.node,
    }),
    'GET /display': async (query) => displayView(query.project, query.id ?? query.canvas),
    'GET /outline': async (query) => readView(query.project, query.id ?? query.canvas, { mode: 'outline' }),
    'GET /tokens': async (query) => tokensView(query.project, query.id ?? query.canvas, {}),
    'GET /components': async (query) => componentsView(query.project, query.id ?? query.canvas, { action: 'list' }),
    'GET /validate': async (query) => validateView(query.project, query.id ?? query.canvas, {
      contrast: query.contrast === undefined ? true : bool(query.contrast),
    }),
    'GET /export': async (query) => exportView(query.project, query.id ?? query.canvas, {
      mode: query.mode,
      frame: query.frame,
      write: false,
      inline: true,
      preview: true,
    }),
    'GET /trash': async () => trashView({ action: 'list' }),
    'GET /config': async () => projectsView({ canvases: true }),
    'POST /create': async (_query, body) => createView(body.project, body.canvas ?? body.id, {
      name: body.name,
      device: body.device,
      template: body.template,
      overwrite: bool(body.overwrite),
      ops: body.ops,
    }),
    'POST /init': async (_query, body) => initProjectView(body.root, body.title),
    'POST /apply': async (_query, body) => applyBatch(body.project, body.canvas ?? body.id, body.ops, {
      expectRev: body.expectRev,
      force: bool(body.force),
      create: body.create !== false,
      name: body.name,
    }),
    'POST /canvas': async (_query, body) => {
      if (!body.doc || typeof body.doc !== 'object') fail(400, 'Нужен «doc» — документ холста.')
      return writeDocView(body.project, body.canvas ?? body.doc.id, body.doc, {
        expectRev: body.expectRev,
        force: bool(body.force),
      })
    },
    'POST /tokens': async (_query, body) => tokensView(body.project, body.canvas ?? body.id, {
      tokens: body.tokens,
      replace: bool(body.replace),
      remove: body.remove,
      expectRev: body.expectRev,
    }),
    'POST /components': async (_query, body) => componentsView(body.project, body.canvas ?? body.id, body),
    'POST /export': async (_query, body) => exportView(body.project, body.canvas ?? body.id, {
      mode: body.mode,
      frame: body.frame,
      write: body.write !== false,
      preview: bool(body.preview),
    }),
    'POST /delete': async (_query, body) => trashView({
      action: 'delete',
      project: body.project,
      canvas: body.canvas ?? body.id,
    }),
    'POST /restore': async (_query, body) => trashView({
      action: 'restore',
      trashId: body.trashId,
      overwrite: bool(body.overwrite),
    }),
  }

  return async function handleDesignRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || DESIGN_ROUTE
    const suffix = path.slice(DESIGN_ROUTE.length) || '/'
    const query = Object.fromEntries(url.searchParams.entries())
    const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${suffix}`
    try {
      const handler = routes[key]
      if (!handler) fail(404, `Неизвестная операция «${key}».`)
      const body = req.method === 'POST' ? await readJsonBody(req) : undefined
      const value = await handler(query, body)
      send(res, 200, value)
    } catch (error) {
      // Статус несёт сама ошибка: его ставят `StoreError`/`ServiceError` из
      // сервиса и локальный `fail` этого файла.
      send(res, error.status ?? 500, {
        error: error.message,
        code: error.code,
        ...(error.payload ?? {}),
      })
    }
  }
}

/** Отправить JSON-ответ. */
function send(res, status, value) {
  const payload = JSON.stringify(value ?? null)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}
