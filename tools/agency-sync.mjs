/**
 * Синхронизация экспертов и команды The Agency с профилем DSH.
 *
 * Проект хранит определения кастомных экспертов (`agency/experts/*.yml`) и
 * команды (`agency/teams/*.yml`) как обычные файлы, версионируемые вместе с
 * кодом плагина. Сам The Agency держит их в конфиге плагина `agency-agents`
 * внутри `cordis.patch.yml` профиля — этот скрипт переносит определения туда.
 *
 * Скрипт правит **только** блок `- id: agency-agents`: остальные строки файла
 * остаются байт в байт. Записи, добавленные человеком через страницу «Эксперт»
 * (например «Архивариус заметок»), не удаляются: чужие slug и id сохраняются,
 * управляемые проектом — перезаписываются по проектной версии.
 *
 * Запуск:
 *   node tools/agency-sync.mjs --dry-run   # показать блок, ничего не писать
 *   node tools/agency-sync.mjs --check     # только сообщить о расхождении (код 1)
 *   node tools/agency-sync.mjs             # записать в профиль (нужна резервная копия)
 *
 * Профиль берётся из `--profile`, иначе из `DSH_PROFILE`, иначе `web`.
 */
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Разобрать аргументы командной строки. */
function parseArgs(argv) {
  const args = { dryRun: false, check: false, profile: process.env.DSH_PROFILE ?? 'web' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--check') args.check = true
    else if (arg === '--profile') args.profile = argv[i += 1]
    else throw new Error(`Неизвестный аргумент «${arg}».`)
  }
  return args
}

/** Найти YAML-парсер: локальный, затем из установки DSH, затем системный. */
function loadYaml(profileDir) {
  const candidates = [
    'yaml',
    join(profileDir, 'node_modules', 'yaml'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml'),
    '/usr/share/nodejs/yaml',
    '/usr/lib/nodejs/yaml',
  ]
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {
      // Пробуем следующий источник.
    }
  }
  throw new Error('Не найден пакет `yaml`: проверку и запись без него выполнить нельзя.')
}

/** Прочитать определения проекта. */
async function readProjectDefinitions(yaml) {
  const expertsDir = join(root, 'agency', 'experts')
  const teamsDir = join(root, 'agency', 'teams')
  const experts = []
  for (const file of (await readdir(expertsDir)).filter((name) => name.endsWith('.yml')).sort()) {
    const parsed = yaml.parse(await readFile(join(expertsDir, file), 'utf8'))
    experts.push({ file, value: parsed })
  }
  const teams = []
  for (const file of (await readdir(teamsDir)).filter((name) => name.endsWith('.yml')).sort()) {
    const parsed = yaml.parse(await readFile(join(teamsDir, file), 'utf8'))
    teams.push({ file, value: parsed })
  }
  if (experts.length === 0 && teams.length === 0) {
    throw new Error('В agency/ нет определений: нечего синхронизировать.')
  }
  return { experts, teams }
}

/** Отдать значение как YAML-блок с отступом в 6 пробелов (уровень элементов списка). */
function renderList(yaml, values) {
  const text = yaml.stringify(values, { indent: 2, lineWidth: 0, blockQuote: 'literal' })
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line === '' ? '' : `      ${line}`))
    .join('\n')
}

/** Найти границы блока `- id: agency-agents` в тексте патча. */
function findBlock(lines) {
  const start = lines.findIndex((line) => line === '- id: agency-agents')
  if (start === -1) throw new Error('В патче профиля нет строки `- id: agency-agents`.')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('- id: ')) {
      end = i
      break
    }
  }
  return { start, end }
}

/** Разложить блок на секции по ключам с отступом в 4 пробела; шапка блока — отдельно. */
function splitSections(lines, start, end) {
  const prefix = []
  const sections = new Map()
  let key = null
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i]
    const header = /^ {4}([A-Za-z][A-Za-z0-9]*):/.exec(line)
    if (header) {
      key = header[1]
      sections.set(key, [line])
      continue
    }
    if (key === null) prefix.push(line)
    else sections.get(key).push(line)
  }
  return { prefix, sections }
}

/** Разбить секцию-список на сырые записи по началу элемента. */
function splitEntries(body, pattern) {
  const entries = []
  let current = null
  for (const line of body) {
    if (pattern.test(line)) {
      if (current !== null) entries.push(current)
      current = [line]
      continue
    }
    if (current !== null) current.push(line)
  }
  if (current !== null) entries.push(current)
  return entries.map((lines) => lines.join('\n').replace(/\s+$/, ''))
}

/** Собрать блок agency-agents заново: чужие записи сохраняются, проектные перезаписываются. */
function buildBlock(yaml, parsed, { experts, teams }) {
  const { prefix, sections } = parsed
  const slugOf = (entry, key) => new RegExp(`^\\s+- ${key}: (\\S+)\\s*$`, 'm').exec(entry)?.[1]
  const enabled = (sections.get('enabled') ?? [])
    .map((line) => /^ {6}- (.+)$/.exec(line)?.[1]?.trim())
    .filter((value) => value !== undefined)
  const managedSlugs = experts.map((expert) => expert.value.slug)
  const managedIds = teams.map((team) => team.value.id)

  const expertEntries = splitEntries(sections.get('customExperts') ?? [], /^ {6}- slug: /)
  const keptExperts = expertEntries.filter((entry) => !managedSlugs.includes(slugOf(entry, 'slug')))
  const teamEntries = splitEntries(sections.get('customTeams') ?? [], /^ {6}- id: /)
  const keptTeams = teamEntries.filter((entry) => !managedIds.includes(slugOf(entry, 'id')))
  const enabledTeams = (sections.get('enabledTeams') ?? [])
    .map((line) => /^ {6}- (.+)$/.exec(line)?.[1]?.trim())
    .filter((value) => value !== undefined)

  const nextEnabled = [...enabled]
  for (const slug of managedSlugs) if (!nextEnabled.includes(slug)) nextEnabled.push(slug)
  const nextEnabledTeams = [...enabledTeams]
  for (const id of managedIds) if (!nextEnabledTeams.includes(id)) nextEnabledTeams.push(id)

  const out = ['- id: agency-agents', ...prefix, ...(sections.get('root') ?? [])]
  out.push(...(sections.get('divisions') ?? []))
  out.push('    enabled:')
  for (const slug of nextEnabled) out.push(`      - ${slug}`)
  out.push('    customExperts:')
  for (const entry of keptExperts) out.push(entry)
  if (experts.length > 0) out.push(renderList(yaml, experts.map((expert) => expert.value)))
  out.push('    customTeams:')
  for (const entry of keptTeams) out.push(entry)
  if (teams.length > 0) out.push(renderList(yaml, teams.map((team) => team.value)))
  out.push('    enabledTeams:')
  for (const id of nextEnabledTeams) out.push(`      - ${id}`)
  return out
}

/** Проверить определения до записи: конфиг профиля валидируется целиком, и плохой файл ломает The Agency. */
function validateDefinitions({ experts, teams }) {
  const problems = []
  const len = (value) => (typeof value === 'string' ? Array.from(value).length : 0)
  const CUSTOM_SLUG = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  const CUSTOM_TEAM = /^team-custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  for (const { file, value: expert } of experts) {
    if (!CUSTOM_SLUG.test(expert.slug ?? '')) problems.push(`${file}: slug должен быть custom-<uuid v4>`)
    if (len(expert.name) < 1 || len(expert.name) > 40) problems.push(`${file}: имя 1..40 символов`)
    if (/[@\r\n\u0000-\u001f\u007f]/u.test(expert.name ?? '')) problems.push(`${file}: в имени недопустимые символы`)
    if (len(expert.description) < 1 || len(expert.description) > 160) problems.push(`${file}: описание 1..160 символов`)
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(expert.division ?? '')) problems.push(`${file}: division — латиница вида engineering`)
    if (!Number.isInteger(expert.avatar) || expert.avatar < 0 || expert.avatar > 35) problems.push(`${file}: avatar 0..35`)
    if (len(expert.prompt) < 1 || len(expert.prompt) > 20000) problems.push(`${file}: промпт 1..20000 символов`)
  }
  const slugs = new Set()
  for (const { file, value: team } of teams) {
    if (!CUSTOM_TEAM.test(team.id ?? '')) problems.push(`${file}: id должен быть team-custom-<uuid v4>`)
    if (team.builtin !== false) problems.push(`${file}: нужно builtin: false`)
    if (len(team.name) < 1 || len(team.name) > 40) problems.push(`${file}: имя 1..40 символов`)
    if (len(team.description) < 1 || len(team.description) > 160) problems.push(`${file}: описание 1..160 символов`)
    if (!Array.isArray(team.tags) || team.tags.length > 3) problems.push(`${file}: tags — не больше трёх`)
    else if (team.tags.some((tag) => len(tag) > 16)) problems.push(`${file}: каждый тег не длиннее 16 символов`)
    for (const key of ['goal', 'deliveryRequirements']) {
      if (len(team[key]) < 1 || len(team[key]) > 2000) problems.push(`${file}: ${key} 1..2000 символов`)
    }
    if (len(team.constraints) > 2000) problems.push(`${file}: constraints не длиннее 2000 символов`)
    if (!Array.isArray(team.examples) || team.examples.length < 1 || team.examples.length > 3) {
      problems.push(`${file}: examples — от одного до трёх`)
    } else if (team.examples.some((item) => typeof item !== 'string' || len(item) > 1000)) {
      problems.push(`${file}: каждый пример — строка не длиннее 1000 символов`)
    }
    if (!Array.isArray(team.members) || team.members.length < 2 || team.members.length > 8) {
      problems.push(`${file}: участников от двух до восьми`)
    } else {
      const seen = new Set()
      for (const member of team.members) {
        if (seen.has(member.expertSlug)) problems.push(`${file}: участник ${member.expertSlug} указан дважды`)
        seen.add(member.expertSlug)
        if (len(member.duty) < 1 || len(member.duty) > 100) problems.push(`${file}: duty 1..100 символов`)
        if (len(member.instructions) < 1 || len(member.instructions) > 2000) problems.push(`${file}: instructions 1..2000 символов`)
      }
    }
    if (!['template', 'custom'].includes(team.coordinatorMode)) problems.push(`${file}: coordinatorMode — template или custom`)
    if (team.coordinatorMode === 'custom' && len(team.coordinatorPrompt) < 1) problems.push(`${file}: для custom нужен coordinatorPrompt`)
    if (len(team.coordinatorPrompt) > 12000) problems.push(`${file}: coordinatorPrompt не длиннее 12000 символов`)
    if (!['general', 'product', 'technical', 'content', 'data', 'research'].includes(team.coordinatorTemplateId)) {
      problems.push(`${file}: неизвестный coordinatorTemplateId`)
    }
    if (team.coordinatorTemplateVersion !== 1) problems.push(`${file}: coordinatorTemplateVersion должен быть 1`)
  }
  for (const { value: expert } of experts) {
    if (slugs.has(expert.slug)) problems.push(`agency: slug ${expert.slug} повторяется`)
    slugs.add(expert.slug)
  }
  if (problems.length > 0) throw new Error(`определения не проходят схему The Agency:\n  - ${problems.join('\n  - ')}`)
}

/** Точка входа: собрать новый текст патча и (если нужно) записать его. */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', args.profile)
  const yaml = loadYaml(profileDir)
  const definitions = await readProjectDefinitions(yaml)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const original = await readFile(patchPath, 'utf8')
  const lines = original.split('\n')
  const { start, end } = findBlock(lines)
  const parsed = splitSections(lines, start, end)
  const block = buildBlock(yaml, parsed, definitions)
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')

  // Проверка: патч должен остаться корректным YAML, иначе харнесс не загрузит профиль.
  yaml.parse(next)
  const changed = next !== original
  if (args.dryRun) {
    process.stdout.write(`${block.join('\n')}\n`)
    process.stdout.write(`\n# ${changed ? 'блок изменится' : 'блок уже совпадает'}\n`)
    return
  }
  if (args.check) {
    process.stdout.write(changed ? 'agency: профиль расходится с agency/\n' : 'agency: профиль совпадает с agency/\n')
    if (changed) process.exitCode = 1
    return
  }
  if (!changed) {
    process.stdout.write('agency: профиль уже совпадает с agency/, запись не нужна.\n')
    return
  }
  const backup = `${patchPath}.bak-agency-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  await copyFile(patchPath, backup)
  await writeFile(patchPath, next, 'utf8')
  process.stdout.write(`agency: записано в ${patchPath}\nagency: резервная копия ${backup}\n`)
  process.stdout.write(`agency: экспертов ${definitions.experts.length}, команд ${definitions.teams.length}; перезапуск DSH не нужен — профиль живой.\n`)
}

await main().catch((error) => {
  process.stderr.write(`agency: ${error.message}\n`)
  process.exitCode = 1
})
