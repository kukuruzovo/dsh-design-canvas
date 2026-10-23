/**
 * Проверка автономного редактора: сервер `standalone.js` и его статика.
 *
 * Тест поднимает тот же обработчик, что запускает CLI, на свободном порту
 * петлевого адреса и прогоняет окно редактора как браузер: страница оболочки,
 * вендорный React, сам `client.js` и полный цикл работы с холстом через
 * `/api/dsh-design-canvas` — чтение, правка, конфликт ревизий, отказ.
 * Отдельно проверяются правило доступа (токен, как только окно видно не только
 * с этого компьютера), защита от обхода пути и аргументы CLI. Если на машине
 * есть Tailscale, дополнительно проверяется `--tailscale`; если нет — шаг
 * честно помечается пропущенным, а не считается пройденным.
 *
 * Запуск: `node smoke-standalone.mjs`.
 */
import { mkdtemp, rm, mkdir, cp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const home = await mkdtemp(join(tmpdir(), 'dsh-design-stand-home-'))
const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-design-stand-proj-'))
process.env.DSH_HOME = home
await mkdir(home, { recursive: true })
await cp(join(import.meta.dirname, 'demo', '.design'), join(projectRoot, '.design'), { recursive: true })

const { createStandaloneServer, resolveAccess } = await import('./standalone.js')
const { registerProject } = await import('./store.js')

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ✓ ${label}`)
}

/** Поднять сервер на свободном порту и вернуть адрес и функцию остановки. */
async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Запустить CLI и дождаться строки с адресом окна.
 *
 * @param {string[]} args Аргументы `standalone.js`.
 * @param {RegExp} [expect] Дополнительная строка, которую нужно дождаться: часть
 *   вывода печатается уже после адреса, и без этого ассерт ловил бы гонку.
 * @returns {Promise<{child: object, base: string, output: () => string}>}
 */
function startCli(args, expect = null) {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'standalone.js'), ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`CLI не напечатал адрес за 10 с:\n${output}\n${errors}`))
    }, 10000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      const url = output.match(/http:\/\/[0-9a-fA-F.:[\]]+:\d+\/?/)
      if (!url || (expect && !expect.test(output))) return
      clearTimeout(timer)
      resolve({ child, base: url[0].replace(/\/$/, ''), output: () => output })
    })
    child.stderr.on('data', (chunk) => { errors += String(chunk) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`CLI завершился с кодом ${code}:\n${output}\n${errors}`))
    })
  })
}

/** Адрес этого узла в tailnet — или null, если Tailscale не отвечает. */
function tailnetAddress() {
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 4000 }, (error, stdout) => {
      const value = String(stdout ?? '').trim().split('\n')[0]?.trim() ?? ''
      resolve(!error && /^100\./.test(value) ? value : null)
    })
  })
}

const servers = []
try {
  const projectId = await registerProject(projectRoot, 'Standalone smoke')
  const main = await listen(createStandaloneServer())
  servers.push(main)

  // ------------------------------------------------------- страница и статика ----
  const page = await fetch(`${main.base}/`)
  assert.equal(page.status, 200, `страница редактора: ${page.status}`)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/, 'страница отдана не как HTML')
  const html = await page.text()
  for (const asset of ['/theme.css', '/vendor/react.js', '/vendor/react-dom.js', '/shell.js', '/client.js']) {
    assert.ok(html.includes(`"${asset}"`), `страница не подключает ${asset}`)
  }
  assert.ok(
    html.indexOf('/shell.js') < html.indexOf('/client.js'),
    'шим загрузчика должен идти до client.js',
  )
  ok('страница оболочки подключает React, шим и панель в правильном порядке')

  const shell = await (await fetch(`${main.base}/shell.js`)).text()
  assert.match(shell, /__ModuleLoader__/, 'шим не ставит window.__ModuleLoader__')
  assert.match(shell, /slots/, 'шим не реализует слоты')
  assert.match(shell, /locale/, 'шим не реализует словари')
  ok('шим оболочки реализует ровно те сервисы, которые зовёт панель')

  const react = await (await fetch(`${main.base}/vendor/react.js`)).text()
  assert.match(react, /React/, 'вендорный React не отдаётся')
  const reactDom = await (await fetch(`${main.base}/vendor/react-dom.js`)).text()
  assert.match(reactDom, /createRoot/, 'вендорный ReactDOM не отдаётся')
  ok('React 18 отдаётся локально — окно редактора не зависит от сети и харнесса')

  const theme = await (await fetch(`${main.base}/theme.css`)).text()
  assert.match(theme, /--dsw-alias-bg-base/, 'тема не задаёт переменные панели')
  assert.match(theme, /\[data-theme='dark'\]/, 'тема не умеет тёмный режим')
  for (const variable of ['--dsw-alias-label-primary', '--dsw-alias-border-l1', '--dsw-alias-brand-primary']) {
    assert.ok(theme.includes(variable), `тема не задаёт ${variable}`)
  }
  ok('тема задаёт переменные --dsw-* для светлого и тёмного режимов')

  const client = await (await fetch(`${main.base}/client.js`)).text()
  assert.match(client, /window\.__ModuleLoader__\.load/, 'client.js отдаётся не тем файлом')
  ok('панель отдаётся тем же client.js, что грузит харнесс')

  // ------------------------------------------------------------------ отказы ----
  assert.equal((await fetch(`${main.base}/../package.json`)).status, 404, 'обход пути не закрыт')
  assert.equal((await fetch(`${main.base}/vendor/%2e%2e%2fpackage.json`)).status, 404, 'обход пути через %2e не закрыт')
  assert.equal((await fetch(`${main.base}/nope.js`)).status, 404, 'неизвестный файл отдаётся')
  const wrongMethod = await fetch(`${main.base}/`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405, 'POST на статику не отвергнут')
  const unknownOp = await fetch(`${main.base}/api/dsh-design-canvas/nope`)
  assert.equal(unknownOp.status, 404, 'неизвестная операция API не отвергнута')
  assert.match((await unknownOp.json()).error, /nope/, 'отказ API без объяснения')
  ok('обход пути, неизвестный файл, метод и операция отвергаются')

  // -------------------------------------------------------------------- API ----
  const health = await (await fetch(`${main.base}/healthz`)).json()
  assert.equal(health.ok, true, 'healthz не отвечает')
  assert.equal(health.mode, 'standalone', 'healthz не называет режим')
  ok(`healthz отвечает: ${health.plugin} ${health.version ?? ''}`.trim())

  const config = await (await fetch(`${main.base}/api/dsh-design-canvas/config`)).json()
  const entry = config.projects.find((project) => project.id === projectId)
  assert.ok(entry, `реестр автономного сервера не видит проект ${projectId}`)
  assert.ok(entry.initialized, 'проект в реестре не помечен инициализированным')
  ok(`реестр проектов читается из того же файла, что у харнесса: ${projectId}`)

  const query = `project=${encodeURIComponent(projectRoot)}`
  const canvases = await (await fetch(`${main.base}/api/dsh-design-canvas/canvases?${query}`)).json()
  assert.ok(canvases.canvases.some((canvas) => canvas.id === 'quiz-home'), 'холст демо-проекта не виден по пути')
  ok(`холсты проекта видны по пути: ${canvases.canvases.map((canvas) => canvas.id).join(', ')}`)

  const display = await (await fetch(`${main.base}/api/dsh-design-canvas/display?${query}&id=quiz-home`)).json()
  assert.ok(display.doc, 'display не вернул документ')
  assert.ok((display.display?.children ?? []).length > 0, 'display не развернул дерево')
  assert.ok(display.rev > 0, 'display не вернул ревизию')
  ok(`холст читается: фреймов ${display.display.children.length}, ревизия ${display.rev}`)

  const apply = (body) => fetch(`${main.base}/api/dsh-design-canvas/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: projectRoot, canvas: 'quiz-home', ...body }),
  })

  const renamed = await apply({ expectRev: display.rev, ops: [{ op: 'set-canvas', name: 'Автономная правка' }] })
  assert.equal(renamed.status, 200, `правка через автономный сервер не прошла: ${renamed.status}`)
  const renamedBody = await renamed.json()
  assert.equal(renamedBody.rev, display.rev + 1, 'ревизия не выросла на единицу')
  ok(`правка холста идёт через тот же service.js: ревизия ${display.rev} → ${renamedBody.rev}`)

  const conflict = await apply({ expectRev: display.rev, ops: [{ op: 'set-canvas', name: 'Устаревшая правка' }] })
  assert.equal(conflict.status, 409, `устаревшая ревизия не дала 409: ${conflict.status}`)
  ok('конфликт ревизий в автономном окне ведёт себя как в харнессе (409)')

  const bad = await apply({ expectRev: renamedBody.rev, ops: [{ op: 'нет-такой-операции' }] })
  assert.equal(bad.status, 400, `плохая операция не отвергнута: ${bad.status}`)
  const afterBad = await (await fetch(`${main.base}/api/dsh-design-canvas/canvas?${query}&id=quiz-home`)).json()
  assert.equal(afterBad.rev, renamedBody.rev, 'неудачный батч изменил документ')
  ok('неудачный батч откатывается: документ на диске не изменился')

  // --------------------------------------------------------------- токен ----
  const locked = await listen(createStandaloneServer({ token: 's3cret-token' }))
  servers.push(locked)
  assert.equal((await fetch(`${locked.base}/api/dsh-design-canvas/config`)).status, 401, 'API без токена открыт')
  const withHeader = await fetch(`${locked.base}/api/dsh-design-canvas/config`, { headers: { 'x-dsh-token': 's3cret-token' } })
  assert.equal(withHeader.status, 200, 'API не принял токен из заголовка')
  const cookiePage = await fetch(`${locked.base}/?token=s3cret-token`)
  const cookie = (cookiePage.headers.get('set-cookie') ?? '').split(';')[0]
  assert.match(cookie, /^dsh_design_token=s3cret-token$/, `страница не выдала cookie с токеном: ${cookie}`)
  const withCookie = await fetch(`${locked.base}/api/dsh-design-canvas/config`, { headers: { cookie } })
  assert.equal(withCookie.status, 200, 'API не принял токен из cookie')
  assert.equal((await fetch(`${locked.base}/healthz`)).status, 200, 'healthz закрыт токеном')
  ok('токен защищает API, а страница с ?token= выдаёт cookie для панели')

  // ------------------------------------------------- правило доступа ----
  // Правило одно: как только окно видно не только с этого компьютера, доступ
  // закрывается токеном. Проверяется отдельно от запуска — это чистая функция.
  const local = resolveAccess({ host: '127.0.0.1' })
  assert.equal(local.host, '127.0.0.1', 'петлевой адрес не должен меняться')
  assert.equal(local.token, null, 'на петлевом адресе токен не нужен')
  assert.equal(local.exposed, false, 'петлевой адрес не считается внешним')

  const wide = resolveAccess({ host: '0.0.0.0' })
  assert.equal(wide.exposed, true, 'адрес 0.0.0.0 не признан внешним')
  assert.match(wide.token ?? '', /^[a-f0-9]{32}$/, 'на внешнем адресе токен не сгенерирован')
  assert.equal(wide.generated, true, 'сгенерированный токен не помечен как сгенерированный')

  const tailnet = resolveAccess({ host: '127.0.0.1', tailscale: { ip: '100.64.0.1', dnsName: 'host.ts.net' } })
  assert.equal(tailnet.host, '100.64.0.1', '--tailscale не перенёс прослушивание на адрес tailnet')
  assert.match(tailnet.token ?? '', /^[a-f0-9]{32}$/, 'tailnet-адрес остался без токена')

  const forced = resolveAccess({ host: '0.0.0.0', hostExplicit: true, tailscale: { ip: '100.64.0.1', dnsName: null } })
  assert.equal(forced.host, '0.0.0.0', 'явный --host должен побеждать --tailscale')

  const served = resolveAccess({ host: '127.0.0.1', tailscaleServe: true })
  assert.equal(served.host, '127.0.0.1', 'прокси не должен менять адрес прослушивания')
  assert.equal(served.exposed, true, 'через прокси окно доступно не только локально')
  assert.match(served.token ?? '', /^[a-f0-9]{32}$/, 'за прокси окно осталось без токена')

  const own = resolveAccess({ host: '0.0.0.0', token: 'my-own-token' })
  assert.equal(own.token, 'my-own-token', 'свой токен подменён')
  assert.equal(own.generated, false, 'свой токен помечен как сгенерированный')
  ok('правило доступа: наружу — только с токеном, своим или сгенерированным')

  // ------------------------------------------------------------------ CLI ----
  const run = (args) => new Promise((resolve) => {
    execFile(process.execPath, [join(import.meta.dirname, 'standalone.js'), ...args], { env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })

  const help = await run(['--help'])
  assert.equal(help.code, 0, '--help завершился ошибкой')
  assert.match(help.stdout, /--port/, 'справка не описывает порт')
  assert.match(help.stdout, /--project/, 'справка не описывает регистрацию проекта')
  assert.match(help.stdout, /--tailscale/, 'справка не описывает работу в tailnet')
  ok('CLI печатает справку')

  const bogus = await run(['--nope'])
  assert.equal(bogus.code, 2, 'неизвестный аргумент не отвергнут')
  assert.match(bogus.stderr, /Неизвестный аргумент/, 'отказ на неизвестный аргумент без объяснения')
  ok('неизвестный аргумент отвергается')

  const weakToken = await run(['--token', 'abc'])
  assert.equal(weakToken.code, 2, 'слишком короткий токен не отвергнут')
  assert.match(weakToken.stderr, /--token/, 'отказ на слабый токен без объяснения')
  ok('слишком короткий токен отвергается: он едет в cookie и в адрес')

  // Внешний адрес без `--token`: сервер не отказывается работать, а сам
  // закрывает доступ токеном и печатает адрес вместе с ним. Токен сохраняется
  // в `$DSH_HOME/design-canvas-token`, поэтому адрес не меняется между
  // запусками — иначе закладка на телефоне ломалась бы каждый раз.
  const exposed = await startCli(['--host', '0.0.0.0', '--port', '0'])
  let firstToken = null
  try {
    assert.match(exposed.base, /^http:\/\/127\.0\.0\.1:\d+$/, `адрес внешнего запуска: ${exposed.base}`)
    firstToken = exposed.output().match(/token=([a-f0-9]{32})/)?.[1]
    assert.ok(firstToken, 'на внешнем адресе токен не сгенерирован')
    assert.match(exposed.output(), /включён токен/, 'запуск не объяснил, откуда взялся токен')
    assert.equal((await fetch(`${exposed.base}/api/dsh-design-canvas/config`)).status, 401, 'внешний адрес открыт без токена')
    assert.equal((await fetch(`${exposed.base}/api/dsh-design-canvas/config?token=${firstToken}`)).status, 200, 'токен внешнего запуска не принят')
  } finally {
    exposed.child.kill('SIGTERM')
  }
  ok('внешний адрес поднимается только с токеном — он напечатан в адресе')

  const tokenPath = join(home, 'design-canvas-token')
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600, 'файл токена доступен не только владельцу')
  const again = await startCli(['--host', '0.0.0.0', '--port', '0'])
  try {
    assert.equal(again.output().match(/token=([a-f0-9]{32})/)?.[1], firstToken, 'токен не пережил перезапуск: адрес окна менялся бы каждый раз')
  } finally {
    again.child.kill('SIGTERM')
  }
  ok('токен сохраняется в $DSH_HOME с правами 0600 и переживает перезапуск')

  const chosen = await startCli(['--host', '0.0.0.0', '--port', '0', '--token', 'my-own-token'])
  try {
    assert.match(chosen.output(), /token=my-own-token/, 'свой --token не попал в адрес')
    assert.equal((await fetch(`${chosen.base}/api/dsh-design-canvas/config?token=my-own-token`)).status, 200, 'свой токен не принят')
  } finally {
    chosen.child.kill('SIGTERM')
  }
  ok('--token со значением побеждает сохранённый токен')

  // -------------------------------------------- tailnet, если он есть ----
  // Шаг зависит от машины: без запущенного Tailscale он честно помечается
  // пропущенным, а не считается пройденным.
  const tailnetIp = await tailnetAddress()
  if (!tailnetIp) {
    console.log('  · tailnet не найден (Tailscale не отвечает) — проверка --tailscale пропущена')
  } else {
    const cli = await startCli(['--tailscale', '--port', '0', '--project', projectRoot], /в tailnet по имени/)
    try {
      assert.equal(cli.base, `http://${tailnetIp}:${new URL(cli.base).port}`, `--tailscale слушает не адрес tailnet: ${cli.base}`)
      const token = cli.output().match(/token=([a-f0-9]{32})/)?.[1]
      assert.ok(token, 'на tailnet-адресе нет токена')
      assert.equal((await fetch(`${cli.base}/healthz`)).status, 200, 'healthz не отвечает по адресу tailnet')
      assert.equal((await fetch(`${cli.base}/api/dsh-design-canvas/config`)).status, 401, 'API в tailnet открыт без токена')
      assert.equal((await fetch(`${cli.base}/api/dsh-design-canvas/config?token=${token}`)).status, 200, 'API в tailnet не принял токен')
      ok(`--tailscale слушает ${tailnetIp} и закрыт токеном: окно видно с других устройств tailnet`)
    } finally {
      cli.child.kill('SIGTERM')
    }
  }

  // Файл на диске действительно переписан тем же форматом, что у инструментов.
  const onDisk = JSON.parse(await readFile(join(projectRoot, '.design', 'quiz-home.canvas.json'), 'utf8'))
  assert.equal(onDisk.name, 'Автономная правка', 'правка не доехала до файла холста')
  assert.equal(onDisk.rev, renamedBody.rev, 'ревизия в файле не совпадает с ответом API')
  ok('правка из автономного окна лежит в <проект>/.design/ как обычный холст')
} finally {
  for (const server of servers) await server.close()
  await rm(home, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
}

console.log(`\nАвтономный редактор в порядке: ${checks} проверок.`)
