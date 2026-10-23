#!/usr/bin/env node
/**
 * Автономный редактор макетов: тот же редактор, что и панель «Макеты» в DSH,
 * но на своём порту и в своём окне — открывается независимо от харнесса.
 *
 * Сервер ничего не переписывает заново: он отдаёт статику оболочки
 * (`standalone/`) и монтирует тот же обработчик `/api/dsh-design-canvas`, что
 * регистрирует `index.js` внутри DSH. Значит, обе половины — окно редактора и
 * инструменты агента `design_*` — работают с одними файлами `<проект>/.design/`
 * через один `service.js`.
 *
 * Запуск:
 *   node standalone.js                      # http://127.0.0.1:5178/
 *   node standalone.js --port 4180 --open
 *   node standalone.js --project ~/app/foo  # зарегистрировать корень в реестре
 *   node standalone.js --host 0.0.0.0 --token   # наружу — только с токеном
 *
 * По умолчанию сервер слушает петлевой адрес: маршрут умеет писать файлы в
 * `.design/` проектов, и выставлять его в сеть без токена нельзя.
 */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_ROUTE, createDesignHandler } from './route.js'
import { configPath, expandHome, registerProject } from './store.js'

const ROOT = dirname(fileURLToPath(import.meta.url))

/** Порт по умолчанию: рядом с `dsh web` (3080), но не он. */
const DEFAULT_PORT = 5178
/** Адрес по умолчанию: только этот компьютер. */
const DEFAULT_HOST = '127.0.0.1'
/** Имя cookie, в которое превращается `--token`. */
const TOKEN_COOKIE = 'dsh_design_token'
/**
 * Диапазон адресов tailnet (`100.64.0.0/10`, CGNAT).
 *
 * По нему узнаётся адрес интерфейса `tailscale0`, когда CLI `tailscale` недоступен:
 * адрес из этого диапазона не выдаётся домашним роутером, поэтому спутать его с
 * адресом локальной сети нельзя.
 */
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

/**
 * Статика оболочки: путь запроса → файл и тип.
 *
 * Список закрытый: путь наружу не вычисляется из запроса, поэтому выйти за
 * пределы каталога плагина нельзя даже теоретически.
 */
const ASSETS = new Map([
  ['/theme.css', { file: 'standalone/theme.css', type: 'text/css; charset=utf-8' }],
  ['/shell.js', { file: 'standalone/shell.js', type: 'text/javascript; charset=utf-8' }],
  ['/client.js', { file: 'client.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/react.js', { file: 'vendor/react.production.min.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/react-dom.js', { file: 'vendor/react-dom.production.min.js', type: 'text/javascript; charset=utf-8' }],
  ['/icon.svg', { file: 'icon.svg', type: 'image/svg+xml' }],
])

/** Разобранные аргументы командной строки. */
function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    hostExplicit: false,
    projects: [],
    token: null,
    tailscale: false,
    tailscaleServe: false,
    open: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => argv[i + 1]
    if (arg === '--port' || arg === '-p') {
      const raw = value()
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('--port ждёт число.')
      options.port = Number(raw)
      i += 1
    } else if (arg === '--host') {
      const raw = value()
      if (raw === undefined) throw new Error('--host ждёт адрес.')
      options.host = raw
      options.hostExplicit = true
      i += 1
    } else if (arg === '--tailscale') {
      options.tailscale = true
    } else if (arg === '--tailscale-serve') {
      options.tailscaleServe = true
    } else if (arg === '--project') {
      const raw = value()
      if (raw === undefined) throw new Error('--project ждёт путь к корню проекта.')
      options.projects.push(raw)
      i += 1
    } else if (arg === '--token') {
      const raw = value()
      // `--token` без значения — сгенерировать; `--token abc` — задать свой.
      options.token = raw === undefined || raw.startsWith('--') ? randomBytes(16).toString('hex') : raw
      if (raw !== undefined && !raw.startsWith('--')) i += 1
      // Токен едет в cookie и в query: пробелы и разделители сломали бы и то, и другое.
      if (!/^[A-Za-z0-9._~-]{8,128}$/.test(options.token)) {
        throw new Error('--token: нужны 8–128 символов из латиницы, цифр и . _ ~ -')
      }
    } else if (arg === '--open') {
      options.open = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Неизвестный аргумент «${arg}».`)
    }
  }
  return options
}

/** Справка по запуску. */
function usage() {
  return [
    'Автономный редактор макетов Design Canvas.',
    '',
    '  node standalone.js [опции]',
    '',
    '  -p, --port <число>    порт (по умолчанию 5178, 0 — любой свободный)',
    '      --host <адрес>    адрес прослушивания (по умолчанию 127.0.0.1)',
    '      --tailscale       слушать адрес этого узла в tailnet: окно откроется',
    '                        с телефона или другого компьютера по Tailscale',
    '      --tailscale-serve отдать окно по HTTPS через `tailscale serve`',
    '                        (нужны права root: команда печатает, что запустить)',
    '      --project <путь>  зарегистрировать корень проекта в реестре (можно несколько)',
    '      --token [значение]  требовать токен (cookie или заголовок x-dsh-token);',
    '                        без значения токен генерируется разово; свой — 8–128',
    '                        символов из латиницы, цифр и . _ ~ -',
    '',
    'Когда окно видно не только с этого компьютера, токен включается сам и',
    'сохраняется в $DSH_HOME/design-canvas-token: адрес окна не меняется между',
    'запусками, поэтому ссылку можно держать в закладке на телефоне.',
    '      --open            открыть адрес в браузере по умолчанию',
    '  -h, --help            эта справка',
    '',
    'Редактор правит те же файлы, что и инструменты агента: <проект>/.design/*.canvas.json.',
  ].join('\n')
}

/** Слушает ли сервер только этот компьютер. */
function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Выполнить внешнюю команду и вернуть её вывод, не бросая исключение.
 *
 * @param {string} command Имя команды.
 * @param {string[]} args Аргументы.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCommand(command, args) {
  return new Promise((settle) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      settle({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/**
 * Найти адрес tailnet среди интерфейсов — запасной путь, когда CLI недоступен.
 *
 * @returns {string|null}
 */
function tailnetFromInterfaces() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && TAILNET_V4.test(item.address)) return item.address
    }
  }
  return null
}

/**
 * Узнать адрес этого узла в tailnet и его имя MagicDNS.
 *
 * Адрес берётся у CLI (`tailscale ip -4`), а если CLI нет или он не запущен —
 * с интерфейса `tailscale0` по диапазону CGNAT. Имя нужно только для печати
 * удобного адреса: без MagicDNS оно не разрешается, но IP работает всегда.
 *
 * @returns {Promise<{ip: string, dnsName: string|null}|null>} null — tailnet не найден.
 */
async function detectTailscale() {
  const addresses = await runCommand('tailscale', ['ip', '-4'])
  const candidate = addresses.code === 0 ? (addresses.stdout.trim().split('\n')[0] ?? '').trim() : ''
  const ip = TAILNET_V4.test(candidate) ? candidate : tailnetFromInterfaces()
  if (!ip) return null

  let dnsName = null
  const status = await runCommand('tailscale', ['status', '--json'])
  if (status.code === 0) {
    try {
      const name = JSON.parse(status.stdout)?.Self?.DNSName
      if (typeof name === 'string' && name !== '') dnsName = name.replace(/\.$/, '')
    } catch {
      // Вывод не JSON — обойдёмся адресом.
    }
  }
  return { ip, dnsName }
}

/**
 * Решить, на каком адресе слушать и нужен ли токен.
 *
 * Правило одно: как только окно становится доступно не только с этого
 * компьютера (адрес не петлевой или включён прокси `tailscale serve`), доступ
 * закрывается токеном — заданным или сгенерированным. Молча выставлять наружу
 * маршрут, который пишет файлы в `.design/`, нельзя.
 *
 * @param {object} input Параметры запуска.
 * @param {string} input.host Адрес из `--host`.
 * @param {boolean} [input.hostExplicit] Был ли `--host` задан явно.
 * @param {string|null} [input.token] Токен из `--token`.
 * @param {{ip: string, dnsName: string|null}|null} [input.tailscale] Узел tailnet для `--tailscale`.
 * @param {boolean} [input.tailscaleServe] Включён ли прокси `tailscale serve`.
 * @returns {{host: string, token: string|null, generated: boolean, exposed: boolean}}
 */
export function resolveAccess({ host, hostExplicit = false, token = null, tailscale = null, tailscaleServe = false }) {
  const resolvedHost = tailscale && !hostExplicit ? tailscale.ip : host
  const exposed = tailscaleServe || !isLoopback(resolvedHost)
  const generated = !token && exposed
  return {
    host: resolvedHost,
    token: token ?? (generated ? randomBytes(16).toString('hex') : null),
    generated,
    exposed,
  }
}

/**
 * Адрес для печати и для прокси: `0.0.0.0` показывается петлевым, IPv6 — в скобках.
 *
 * @param {string} host Фактический адрес прослушивания.
 * @returns {string}
 */
function displayHost(host) {
  const address = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return address.includes(':') ? `[${address}]` : address
}

/** Файл с постоянным токеном автономного окна: лежит рядом с реестром проектов. */
function tokenFile() {
  return join(dirname(configPath()), 'design-canvas-token')
}

/**
 * Взять постоянный токен или создать его.
 *
 * Токен переживает перезапуск: адрес окна остаётся тем же, и его можно положить
 * в закладку на телефоне. Файл создаётся с правами `0600` — читать его больше
 * некому. Если записать не удалось, токен живёт до перезапуска.
 *
 * @returns {Promise<string>}
 */
async function loadOrCreateToken() {
  const file = tokenFile()
  try {
    const saved = (await readFile(file, 'utf8')).trim()
    if (/^[A-Za-z0-9._~-]{8,128}$/.test(saved)) return saved
  } catch {
    // Файла ещё нет — сейчас создадим.
  }
  const token = randomBytes(16).toString('hex')
  try {
    await writeFile(file, `${token}\n`, { mode: 0o600 })
  } catch {
    // Каталог недоступен на запись — обойдёмся токеном на один запуск.
  }
  return token
}

/**
 * Адрес локального сервера для `tailscale serve`.
 *
 * Слушающий `0.0.0.0` проксировать нечем — ему соответствует `127.0.0.1`.
 *
 * @param {string} host Фактический адрес прослушивания.
 * @param {number} port Порт.
 * @returns {string}
 */
function serveTarget(host, port) {
  return `http://${displayHost(host)}:${port}`
}

/** Сравнить строки без утечки длины по времени. */
function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/** Отправить ответ целиком. */
function send(res, status, body, type, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    ...headers,
  })
  if (res.req?.method === 'HEAD') res.end()
  else res.end(payload)
}

/** Отправить JSON. */
function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value ?? null), 'application/json; charset=utf-8')
}

/**
 * Достать токен из запроса: cookie ставит сам сервер, заголовок — для скриптов.
 *
 * @param {object} req Запрос Node.
 * @param {URL} url Разобранный адрес.
 * @returns {string|null}
 */
function requestToken(req, url) {
  const header = req.headers['x-dsh-token']
  if (typeof header === 'string' && header !== '') return header
  const query = url.searchParams.get('token')
  if (query) return query
  const cookies = String(req.headers.cookie ?? '')
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === TOKEN_COOKIE) return rest.join('=')
  }
  return null
}

/** Прочитать версию плагина для `/healthz`. */
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * Собрать обработчик автономного сервера.
 *
 * @param {object} options `{ token }` — включённый токен доступа или null.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createStandaloneServer({ token = null } = {}) {
  const api = createDesignHandler()
  const version = packageVersion()

  return async function handleStandaloneRequest(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      // Ошибка чтения статики или разбора адреса не должна ронять процесс:
      // сервер живёт долго, а окно редактора просто покажет отказ.
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, error.status ?? 500, { error: error.message })
    }
  }

  /** Разбор запроса: API → статика. */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // --------------------------------------------------------------- API ----
    if (pathname === DESIGN_ROUTE || pathname.startsWith(`${DESIGN_ROUTE}/`)) {
      if (token && !sameSecret(requestToken(req, url), token)) {
        sendJson(res, 401, { error: 'Нужен токен: открой адрес с ?token=… или передай x-dsh-token.' })
        return
      }
      await api(req, res)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: `Метод ${req.method} не поддерживается.` })
      return
    }

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, mode: 'standalone', plugin: 'design-canvas', version })
      return
    }

    // ------------------------------------------------------------ статика ----
    if (pathname === '/' || pathname === '/index.html') {
      const headers = {}
      // Токен из адреса превращается в cookie: панель ходит в API обычным
      // `fetch` без заголовков, и cookie — единственный способ ей представиться.
      if (token && sameSecret(url.searchParams.get('token'), token)) {
        headers['set-cookie'] = `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly`
      }
      const html = await readFile(join(ROOT, 'standalone/index.html'))
      send(res, 200, html, 'text/html; charset=utf-8', headers)
      return
    }

    const asset = ASSETS.get(pathname)
    if (!asset) {
      sendJson(res, 404, { error: `Не найдено: ${pathname}` })
      return
    }
    const body = await readFile(join(ROOT, asset.file))
    send(res, 200, body, asset.type)
  }
}

/** Открыть адрес в браузере по умолчанию (по возможности). */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Нет xdg-open — адрес уже напечатан, открыть можно руками.
  }
}

/** Точка входа CLI. */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`design-canvas: ${error.message}\n\n${usage()}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }

  // Tailnet нужен и для `--tailscale` (адрес прослушивания), и для
  // `--tailscale-serve` (имя для HTTPS-адреса), поэтому узнаём его заранее.
  let tailscale = null
  if (options.tailscale || options.tailscaleServe) {
    tailscale = await detectTailscale()
    if (!tailscale && options.tailscale) {
      console.error(
        'design-canvas: не нашёл адрес tailnet. Проверь, что Tailscale запущен\n' +
        '(`tailscale status`) или укажи адрес явно: --host <адрес>.',
      )
      process.exitCode = 2
      return
    }
  }

  const access = resolveAccess({
    host: options.host,
    hostExplicit: options.hostExplicit,
    token: options.token,
    // Адрес меняет только `--tailscale`: `--tailscale-serve` — это прокси к
    // локальному порту, ему петлевого адреса достаточно.
    tailscale: options.tailscale ? tailscale : null,
    tailscaleServe: options.tailscaleServe,
  })
  // Сгенерированный токен берётся из файла: тогда адрес окна не меняется между
  // запусками и его можно сохранить в закладку на другом устройстве.
  const token = access.generated ? await loadOrCreateToken() : access.token
  if (access.generated) {
    console.log(
      `design-canvas: окно доступно не только с этого компьютера (${access.host}),\n` +
      `поэтому включён токен из ${tokenFile()} — он уже в адресе ниже.`,
    )
  }

  for (const ref of options.projects) {
    // `~` разворачивается до `resolve`: иначе тильда стала бы частью пути от cwd.
    const root = resolve(expandHome(ref))
    try {
      const id = await registerProject(root, undefined)
      console.log(`design-canvas: проект ${id} → ${root}`)
    } catch (error) {
      console.error(`design-canvas: проект «${ref}» не зарегистрирован: ${error.message}`)
      process.exitCode = 1
      return
    }
  }

  const server = createServer(createStandaloneServer({ token }))

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`design-canvas: порт ${options.port} занят. Возьми другой: --port ${options.port + 1}.`)
    } else if (error.code === 'EADDRNOTAVAIL') {
      console.error(`design-canvas: адрес ${access.host} недоступен на этом компьютере.`)
    } else {
      console.error(`design-canvas: ${error.message}`)
    }
    process.exitCode = 1
  })

  server.listen(options.port, access.host, async () => {
    const { port } = server.address()
    const query = token ? `?token=${token}` : ''
    const url = `http://${displayHost(access.host)}:${port}/${query}`
    console.log(`design-canvas: редактор макетов — ${url}`)

    // Имя MagicDNS — второй адрес того же окна: удобнее для телефона, но
    // работает только при включённом MagicDNS, поэтому печатается как вариант.
    if (options.tailscale && tailscale?.dnsName) {
      console.log(`design-canvas: в tailnet по имени — http://${tailscale.dnsName}:${port}/${query}`)
    }

    if (options.tailscaleServe) {
      const target = serveTarget(access.host, port)
      const served = await runCommand('tailscale', ['serve', '--bg', target])
      const dnsName = tailscale?.dnsName
      if (served.code === 0) {
        console.log(`design-canvas: HTTPS — https://${dnsName ?? access.host}/${query}`)
      } else {
        console.error(
          `design-canvas: \`tailscale serve\` не отработал (нужны права root).\n` +
          `  Запусти один раз: sudo tailscale serve --bg ${target}\n` +
          '  Тогда окно будет и здесь: ' + `https://${dnsName ?? access.host}/${query}\n` +
          '  Снять прокси: sudo tailscale serve reset',
        )
      }
    }

    console.log('design-canvas: Ctrl+C — остановить.')
    if (options.open) openBrowser(url)
  })

  const stop = () => {
    server.close(() => process.exit(0))
    // Открытые keep-alive соединения держали бы сервер после Ctrl+C.
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// Модуль импортируется тестами ради `createStandaloneServer`; CLI стартует
// только при прямом запуске файла.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`design-canvas: ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
}
