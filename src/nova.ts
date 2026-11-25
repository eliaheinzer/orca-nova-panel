// Nova tasks, task packs and mail. Read-only everywhere: it reads OD/TASKS.md and _PREP files
// from the Nova OneDrive and queries Apple Mail's local index with the sqlite3 CLI in read-only
// mode. It never writes, sends, moves or marks anything.
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { MailItem, MailSnapshot, PackDetail, PackSection, TaskItem, TaskStage, TasksSnapshot } from './protocol'

/** The Nova OneDrive: among ~/Library/CloudStorage/OneDrive-* folders named with "Nova", the most recently
 *  modified one (an old, disconnected account folder can linger next to the live one). Only the folders'
 *  own dates are read: looking inside a disconnected OneDrive folder can block. */
export function findNovaOneDrive(names: string[], base: string, mtimeOf: (dir: string) => number = () => 0): string {
  const nova = names.filter((n) => /^OneDrive-/i.test(n) && /nova/i.test(n)).sort()
  const best = nova.map((n) => ({ n, t: mtimeOf(join(base, n)) })).sort((a, b) => b.t - a.t)[0]
  return join(base, best?.n ?? 'OneDrive-NovaSBE')
}
function detectOneDrive(): string {
  const base = join(homedir(), 'Library/CloudStorage')
  let names: string[] = []
  try {
    names = readdirSync(base)
  } catch {
    // no CloudStorage folder: fall back to the default name
  }
  return findNovaOneDrive(names, base, (dir) => {
    try {
      return lstatSync(dir).mtimeMs
    } catch {
      return 0
    }
  })
}
export const OD = detectOneDrive()
const TASKS = join(OD, 'TASKS.md')
const MAIL_INDEX = join(homedir(), 'Library/Mail/V10/MailData/Envelope Index')
/** Folder layout inside the Nova OneDrive (see README): TASKS.md and DEADLINES.md sit in its root; a task row
 *  may name its folder as "<ASSIGNMENTS_DIR>/<name>/" in the task text. */
export const ASSIGNMENTS_DIR = '3 Assignments & Group Work'
/** Mail domain of Nova SBE accounts. The Mail tab shows the Apple Mail account whose mail is addressed to it. */
export const NOVA_DOMAIN = 'novasbe.pt'
const INBOX_NAMES = new Set(['posteingang', 'inbox'])
/** Top-level folders that are never shown (German and English Exchange/IMAP names, lower case). */
const SKIP_FOLDERS = new Set([
  'gelöschte elemente', 'deleted items', 'deleted messages', 'trash', 'papierkorb',
  'gesendete elemente', 'sent items', 'sent messages', 'sent',
  'entwürfe', 'drafts',
  'junk-e-mail', 'junk email', 'junk', 'spam',
  'postausgang', 'outbox',
  'archiv', 'archive',
  'unterhaltungsverlauf', 'verlauf der unterhaltung', 'conversation history',
  'notizen', 'notes',
  'rss-feeds', 'rss feeds',
  'synchronisierungsprobleme', 'sync issues',
  'aufgaben', 'tasks', 'journal', 'kalender', 'calendar', 'kontakte', 'contacts'
])
const READ_TIMEOUT_MS = 8000
const TZ = 'Europe/Lisbon'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export class ReadTimeout extends Error {}

export async function readText(path: string): Promise<string> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS)
  try {
    return await readFile(path, { encoding: 'utf8', signal: ac.signal })
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw new ReadTimeout(path)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ---------- time ----------

/** Milliseconds for a wall-clock time in Lisbon. */
export function lisbonMs(y: number, mo: number, d: number, hh: number, mm: number): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(guess))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return guess - (shown - guess)
}

/** Every "25 Nov" (+ optional "14:00") in a Due cell, as ms in Lisbon, in the order written. */
export function parseDues(cell: string, now: number): number[] {
  const re = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?/gi
  const nowY = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date(now)))
  const nowM = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: 'numeric' }).format(new Date(now)))
  const out: number[] = []
  for (const m of cell.matchAll(re)) {
    const month = MONTHS.findIndex((x) => x.toLowerCase() === m[2].slice(0, 3).toLowerCase()) + 1
    let y = m[3] ? Number(m[3]) : nowY
    if (!m[3] && nowM >= 11 && month <= 2) y = nowY + 1
    if (!m[3] && nowM <= 2 && month >= 11) y = nowY - 1
    out.push(lisbonMs(y, month, Number(m[1]), m[4] ? Number(m[4]) : 23, m[5] ? Number(m[5]) : 59))
  }
  return out
}

/** The next upcoming date in a Due cell; the last one when all have passed; null when it has none. */
export function parseDue(cell: string, now: number): number | null {
  const all = parseDues(cell, now)
  if (!all.length) return null
  return all.filter((t) => t >= now).sort((a, b) => a - b)[0] ?? Math.max(...all)
}

// ---------- TASKS.md ----------

export const STAGE_PROGRESS: Record<TaskStage, number> = { 'not-started': 10, prepared: 35, 'in-progress': 60, ready: 85, done: 100 }
export const STAGES: TaskStage[] = ['not-started', 'prepared', 'in-progress', 'ready', 'done']

/** One TASKS.md row as written, before any evidence. */
export interface TaskRow {
  id: string
  row: string // the whole line: an override holds only while this stays the same
  statusRaw: string
  dueRaw: string
  dueAt: number | null
  course: string
  task: string
  urgent: boolean
  rowDone: boolean // ✅ in the Status cell
  passed: boolean // ⚠️ passed/overdue, or every date in the Due cell is past
  link: TaskItem['link']
  folderHint: string // "<ASSIGNMENTS_DIR>/<name>" named in the task text, '' when none
}

/** Stable id from course + task text (not the status, which the sync rewrites). */
export function taskId(course: string, task: string): string {
  let h = 5381
  for (const ch of `${course}|${task}`.toLowerCase().replace(/\s+/g, ' ')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return 't' + h.toString(36)
}

export function parseRows(md: string, now: number): { rows: TaskRow[]; updated: string } {
  const updated = md.match(/^Updated [^\n]*/m)?.[0] ?? ''
  const rows: TaskRow[] = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\|\s*Status\s*\|/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 5) continue
    const [statusRaw, dueRaw, course, taskRaw, linkCell] = cells
    const task = taskRaw.replace(/`/g, '')
    const dueAt = parseDue(dueRaw, now)
    const lm = linkCell.match(/\[(pack|draft)\]\(([^)]+)\)/i)
    rows.push({
      id: taskId(course, task),
      row: line.trim(),
      statusRaw,
      dueRaw,
      dueAt,
      course,
      task,
      urgent: statusRaw.includes('🔥'),
      rowDone: statusRaw.includes('✅'),
      passed: statusRaw.includes('⚠️') || /overdue|passed/i.test(statusRaw) || (dueAt !== null && dueAt < now),
      folderHint: (task.match(new RegExp(ASSIGNMENTS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^/]+/?'))?.[0] ?? '').replace(/\/$/, ''),
      link: lm
        ? { kind: lm[1].toLowerCase() as 'pack' | 'draft', path: lm[2].trim(), label: lm[1].toLowerCase() }
        : { kind: 'none', path: '', label: linkCell.replace(/[[\]]/g, '') || '—' }
    })
  }
  return { rows, updated }
}

export interface FolderFile {
  name: string
  mtime: number
}

/** What the folder shows, newest evidence first: done > ready > in progress > prepared > not started. */
export function stageFromEvidence(row: Pick<TaskRow, 'rowDone' | 'link'>, files: FolderFile[] | null, folderName = ''): { stage: TaskStage; why: string; lastEdit: { file: string; at: number } | null } {
  if (row.rowDone) return { stage: 'done', why: 'TASKS.md row is ticked ✅', lastEdit: null }
  if (!files) {
    return { stage: 'not-started', why: row.link.kind === 'none' && !folderName ? 'no task pack or folder yet' : 'task folder not found or not synced', lastEdit: null }
  }
  if (row.link.kind === 'none') {
    // A folder the row names, without a pack: any real file in it means work has started.
    const real = files.filter((f) => !/^(\.|~\$)/.test(f.name)).sort((a, b) => b.mtime - a.mtime)
    const sub = real.find((f) => /SUBMITTED|_FINAL\b/i.test(f.name))
    if (sub) return { stage: 'done', why: `submitted file in ${folderName}: ${sub.name}`, lastEdit: { file: sub.name, at: sub.mtime } }
    const ready = real.find((f) => /^_READY\b/i.test(f.name))
    if (ready) return { stage: 'ready', why: `ready-to-submit file in ${folderName}: ${ready.name}`, lastEdit: { file: ready.name, at: ready.mtime } }
    if (real.length) return { stage: 'in-progress', why: `${real.length} file${real.length === 1 ? '' : 's'} in ${folderName} (no pack)`, lastEdit: { file: real[0].name, at: real[0].mtime } }
    return { stage: 'not-started', why: `${folderName} is empty`, lastEdit: null }
  }
  const submitted = files.find((f) => /SUBMITTED|_FINAL\b/i.test(f.name))
  if (submitted) return { stage: 'done', why: `submitted file: ${submitted.name}`, lastEdit: { file: submitted.name, at: submitted.mtime } }
  const ready = files.find((f) => /^_READY\b/i.test(f.name))
  if (ready) return { stage: 'ready', why: `ready-to-submit file: ${ready.name}`, lastEdit: { file: ready.name, at: ready.mtime } }
  const pack = files.find((f) => /^_PREP\b/i.test(f.name))
  const packDay = pack?.name.match(/(\d{4})-(\d{2})-(\d{2})/)
  const since = packDay ? lisbonMs(Number(packDay[1]), Number(packDay[2]), Number(packDay[3]), 0, 0) : pack?.mtime ?? 0
  const drafts = files.filter((f) => /^_DRAFT\b/i.test(f.name)).sort((a, b) => b.mtime - a.mtime)
  const work = files
    .filter((f) => !/^(_PREP|_DRAFT|_READY|\.|~\$)/i.test(f.name) && !/\.(tmp|lnk)$/i.test(f.name) && f.mtime > since)
    .sort((a, b) => b.mtime - a.mtime)
  const newest = [...drafts, ...work].sort((a, b) => b.mtime - a.mtime)[0]
  if (work.length) return { stage: 'in-progress', why: `${work.length} file${work.length === 1 ? '' : 's'} edited since the pack (${packDay ? packDay[0] : 'pack date'})`, lastEdit: { file: newest.name, at: newest.mtime } }
  if (drafts.length) return { stage: 'in-progress', why: `${drafts.length} draft${drafts.length === 1 ? '' : 's'} in the folder`, lastEdit: { file: drafts[0].name, at: drafts[0].mtime } }
  if (pack) return { stage: 'prepared', why: 'only the task pack (_PREP) is in the folder', lastEdit: null }
  return { stage: 'not-started', why: 'folder has no pack yet', lastEdit: null }
}

async function listFolder(dir: string): Promise<FolderFile[] | null> {
  const work = (async () => {
    const names = await readdir(dir)
    const out: FolderFile[] = []
    for (const name of names) {
      try {
        const st = await stat(join(dir, name))
        out.push({ name, mtime: st.mtimeMs })
      } catch {
        // vanished or not synced: skip
      }
    }
    return out
  })()
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), READ_TIMEOUT_MS).unref?.())
  try {
    return await Promise.race([work, timeout])
  } catch {
    return null
  }
}

/** OD/<semester>/<term>/<course>/<hint>, searched two levels deep in the semester folders. */
async function findCourseFolder(course: string, hint: string): Promise<string | null> {
  const want = course.toLowerCase()
  try {
    for (const sem of (await readdir(OD)).filter((x) => /semester/i.test(x))) {
      for (const term of await readdir(join(OD, sem)).catch(() => [] as string[])) {
        for (const c of await readdir(join(OD, sem, term)).catch(() => [] as string[])) {
          if (c.toLowerCase() === want) return join(OD, sem, term, c, hint)
        }
      }
    }
  } catch {
    // OneDrive not readable
  }
  return null
}

async function nextStepOf(path: string): Promise<string> {
  try {
    const { sections } = parsePack(await readText(path))
    const s = sections.find((x) => x.title === 'Next step')
    return s ? s.body.replace(/\s+/g, ' ').replace(/^[-*]\s*/, '').trim() : ''
  } catch {
    return ''
  }
}

export interface OverrideStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

let lastRows: TaskRow[] = []

/** Each row with its computed stage. Overrides win while the TASKS.md row is unchanged. */
export async function evaluateRows(rows: TaskRow[], store: OverrideStore | null): Promise<TaskItem[]> {
  return Promise.all(
    rows.map(async (r): Promise<TaskItem> => {
      const dir = r.link.kind !== 'none' ? dirname(r.link.path) : r.folderHint ? await findCourseFolder(r.course, r.folderHint) : null
      const files = dir ? await listFolder(dir) : null
      const ev = stageFromEvidence(r, files, r.folderHint ? basename(r.folderHint) : '')
      let stage = ev.stage
      let stageFrom: TaskItem['stageFrom'] = r.rowDone ? 'tasks.md' : 'evidence'
      let why = ev.why
      let override: TaskStage | null = null
      const saved = store ? ((await store.get('ov.' + r.id).catch(() => null)) as { stage?: TaskStage; row?: string } | null) : null
      if (saved?.stage && STAGES.includes(saved.stage)) {
        if (saved.row === r.row) {
          override = saved.stage
          stage = saved.stage
          stageFrom = 'override'
          why = `set by you in the panel (evidence says: ${ev.why})`
        } else if (store) {
          await store.delete('ov.' + r.id).catch(() => undefined) // the sync changed the row: evidence again
        }
      }
      const nextStep = r.link.kind === 'pack' ? await nextStepOf(r.link.path) : ''
      return {
        id: r.id,
        key: r.id,
        statusRaw: r.statusRaw,
        stage,
        stageFrom,
        why,
        lastEdit: ev.lastEdit,
        override,
        progress: STAGE_PROGRESS[stage],
        dueRaw: r.dueRaw,
        dueAt: r.dueAt,
        course: r.course,
        task: r.task,
        urgent: r.urgent,
        nextStep,
        link: r.link
      }
    })
  )
}

/** Kept for the status bar and older callers: open rows only, soonest first. */
export function parseTasks(md: string, now: number): { tasks: TaskRow[]; hidden: number; updated: string } {
  const { rows, updated } = parseRows(md, now)
  const open = rows.filter((r) => !r.rowDone && !r.passed).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
  return { tasks: open, hidden: rows.length - open.length, updated }
}

export async function tasksSnapshot(store: OverrideStore | null = null): Promise<TasksSnapshot> {
  const now = Date.now()
  try {
    const { rows, updated } = parseRows(await readText(TASKS), now)
    lastRows = rows
    const candidates = rows.filter((r) => !r.passed && !r.rowDone)
    const items = (await evaluateRows(candidates, store)).filter((t) => t.stage !== 'done')
    items.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
    return { tasks: items, hidden: rows.length - items.length, updated, note: items.length ? '' : 'No open tasks in TASKS.md.', readAt: now }
  } catch (err) {
    const note = err instanceof ReadTimeout
      ? 'TASKS.md not synced (OneDrive file is cloud-only).'
      : (err as { code?: string }).code === 'ENOENT'
        ? 'No TASKS.md yet in your Nova OneDrive (format: see README).'
        : `Could not read TASKS.md: ${(err as Error).message}`
    return { tasks: [], hidden: 0, updated: '', note, readAt: now }
  }
}

/** The student's manual stage, tied to the current TASKS.md row; never written to OneDrive. */
export async function setOverride(store: OverrideStore, id: string, stage: TaskStage | null): Promise<void> {
  if (stage === null) return store.delete('ov.' + id)
  if (!STAGES.includes(stage)) throw Object.assign(new Error('Unknown status'), { code: 'invalid' })
  let row = lastRows.find((r) => r.id === id)
  if (!row) {
    lastRows = parseRows(await readText(TASKS), Date.now()).rows
    row = lastRows.find((r) => r.id === id)
  }
  if (!row) throw Object.assign(new Error('That task is no longer in TASKS.md.'), { code: 'not_found' })
  await store.set('ov.' + id, { stage, row: row.row })
}

/** "Status (as of …)" and its siblings, matched by the start of the heading. */
const SECTION_ORDER: { match: RegExp; title: string }[] = [
  { match: /^next step/i, title: 'Next step' },
  { match: /^what & when|^what and when/i, title: 'What & when' },
  { match: /^what the professor wants|^requirements|^rubric/i, title: 'What the professor wants (requirements & rubric)' },
  { match: /^status/i, title: 'Status' },
  { match: /^plan/i, title: 'Plan' },
  { match: /^open questions/i, title: 'Open questions' },
  { match: /^head start/i, title: 'Head start (draft)' },
  { match: /^\S+ head start/i, title: 'Extra head start' },
  { match: /^material already there/i, title: 'Material already there' },
  { match: /^prompt to start/i, title: 'Prompt to start' }
]

export function parsePack(md: string): { title: string; sections: PackSection[] } {
  const title = (md.match(/^# (.*)$/m)?.[1] ?? '').replace(/^_PREP\s*/, '').trim()
  const raw: { heading: string; body: string }[] = []
  for (const chunk of md.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n')
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    const body = (nl === -1 ? '' : chunk.slice(nl + 1)).trim()
    raw.push({ heading, body })
  }
  const sections: PackSection[] = []
  const used = new Set<number>()
  for (const s of SECTION_ORDER) {
    const i = raw.findIndex((r, idx) => !used.has(idx) && s.match.test(r.heading))
    if (i === -1 || !raw[i].body) continue
    used.add(i)
    sections.push({ title: s.title === 'Status' ? raw[i].heading : s.title, body: raw[i].body })
  }
  return { title, sections }
}

function insideOD(p: string): boolean {
  const abs = resolve(p)
  return abs === OD || abs.startsWith(OD + '/')
}

export async function packDetail(path: string): Promise<PackDetail> {
  const out: PackDetail = { path, title: basename(path), sections: [], drafts: [], note: '' }
  if (!insideOD(path)) return { ...out, note: 'This file is outside the Nova OneDrive, so the panel does not read it.' }
  try {
    const { title, sections } = parsePack(await readText(path))
    out.title = title || out.title
    out.sections = sections
    if (!sections.length) out.note = 'This file has no pack sections (it may be a draft): open it to read it.'
  } catch (err) {
    out.note = err instanceof ReadTimeout ? 'Not synced: the file is cloud-only in OneDrive. Open the folder to download it.' : `Could not read the pack: ${(err as Error).message}`
  }
  try {
    const dir = dirname(path)
    out.drafts = (await readdir(dir))
      .filter((f) => /^_(DRAFT|READY)\b/i.test(f))
      .sort()
      .map((f) => ({ name: f, path: join(dir, f) }))
  } catch {
    // folder not readable: no drafts listed
  }
  return out
}

// ---------- opening files and mail ----------

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, { timeout: 10000 }, (err) => (err ? rej(err) : res())))
}

export async function openFile(path: string, reveal = false): Promise<{ ok: boolean; error?: string }> {
  if (!insideOD(path)) return { ok: false, error: 'Only files in the Nova OneDrive can be opened from here.' }
  try {
    await run('/usr/bin/open', reveal ? ['-R', path] : [path])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function openMail(messageId: string): Promise<{ ok: boolean; error?: string }> {
  const id = messageId.trim().replace(/^</, '').replace(/>$/, '')
  if (!/^[^\s<>"']{3,400}$/.test(id)) {
    await run('/usr/bin/open', ['-a', 'Mail']).catch(() => undefined)
    return { ok: false, error: 'No usable Message-ID: opened Mail instead.' }
  }
  try {
    await run('/usr/bin/open', [`message://%3C${encodeURIComponent(id)}%3E`])
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------- Apple Mail (read-only) ----------

function sqliteJson(sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((res, rej) =>
    execFile(
      '/usr/bin/sqlite3',
      ['-readonly', '-json', `file:${MAIL_INDEX}?mode=ro`, sql],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return rej(err)
        const text = stdout.trim()
        try {
          res(text ? (JSON.parse(text) as Record<string, unknown>[]) : [])
        } catch (e) {
          rej(e as Error)
        }
      }
    )
  )
}

/** Folder label for a mailbox URL of the given account, or null when the folder is not shown. */
export function folderOf(url: string, account: string): string | null {
  if (!account || !url.startsWith(account)) return null
  const path = decodeURIComponent(url.slice(account.length)).normalize('NFC')
  const top = path.split('/')[0].trim().toLowerCase()
  if (!top || SKIP_FOLDERS.has(top)) return null
  if (INBOX_NAMES.has(top) && !path.includes('/')) return 'Inbox'
  return path
}

/** "scheme://UUID/" of a mailbox URL. */
export function accountOf(url: string): string | null {
  const m = /^([a-z]+:\/\/[^/]+\/)/i.exec(url)
  return m ? m[1] : null
}

/** The Apple Mail account that receives the most mail addressed to @NOVA_DOMAIN, and that address. */
async function detectNovaAccount(): Promise<{ account: string; address: string } | null> {
  const rows = await sqliteJson(
    `select mb.url url, a.address address, count(*) n from recipients r join addresses a on a.ROWID=r.address
     join messages m on m.ROWID=r.message join mailboxes mb on mb.ROWID=m.mailbox
     where lower(a.address) like '%@${NOVA_DOMAIN}' group by mb.url, lower(a.address);`
  )
  const byAccount = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const acct = accountOf(String(r.url))
    if (!acct) continue
    const m = byAccount.get(acct) ?? new Map<string, number>()
    const addr = String(r.address).toLowerCase()
    m.set(addr, (m.get(addr) ?? 0) + Number(r.n))
    byAccount.set(acct, m)
  }
  return pickNovaAccount(byAccount)
}

/** Pure part of the detection, for tests: account with the most @domain recipients, plus its top address. */
export function pickNovaAccount(byAccount: Map<string, Map<string, number>>): { account: string; address: string } | null {
  let best: { account: string; address: string; total: number } | null = null
  for (const [account, addrs] of byAccount) {
    let total = 0
    let address = ''
    let top = -1
    for (const [a, n] of addrs) {
      total += n
      if (n > top) {
        top = n
        address = a
      }
    }
    if (!best || total > best.total) best = { account, address, total }
  }
  return best ? { account: best.account, address: best.address } : null
}

export async function mailSnapshot(): Promise<MailSnapshot> {
  const snap: MailSnapshot = { account: '', folders: [], mails: [], unreadTotal: 0, newestAt: null, note: '', readAt: Date.now() }
  try {
    const found = await detectNovaAccount()
    if (!found) {
      snap.note = `No Apple Mail account with @${NOVA_DOMAIN} mail was found. Add your Nova account to Apple Mail.`
      return snap
    }
    const account = found.account
    snap.account = found.address
    const boxes = await sqliteJson(`select ROWID id, url from mailboxes where url like '${account.replace(/'/g, "''")}%';`)
    const ids = boxes.filter((b) => folderOf(String(b.url), account) !== null).map((b) => Number(b.id))
    if (!ids.length) {
      snap.note = `No mail folders were found for ${found.address} in Apple Mail.`
      return snap
    }
    const counts = await sqliteJson(
      `select mb.url url, count(*) total, sum(case when m.read=0 then 1 else 0 end) unread from messages m join mailboxes mb on mb.ROWID=m.mailbox where m.deleted=0 and m.mailbox in (${ids.join(',')}) group by mb.url;`
    )
    snap.folders = counts
      .map((c) => ({ name: folderOf(String(c.url), account) ?? '?', total: Number(c.total), unread: Number(c.unread) }))
      .sort((a, b) => (a.name === 'Inbox' ? -1 : b.name === 'Inbox' ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true })))
    snap.unreadTotal = snap.folders.reduce((n, f) => n + f.unread, 0)
    const rows = await sqliteJson(
      `select m.ROWID id, mb.url url, a.comment name, a.address address, s.subject subject, m.subject_prefix prefix, m.date_received at, m.read read, g.message_id_header mid
       from messages m join mailboxes mb on mb.ROWID=m.mailbox left join addresses a on a.ROWID=m.sender
       join subjects s on s.ROWID=m.subject left join message_global_data g on g.ROWID=m.global_message_id
       where m.deleted=0 and m.read=0 and m.mailbox in (${ids.join(',')}) order by m.date_received desc limit 100;`
    )
    snap.mails = rows.map(
      (r): MailItem => ({
        id: Number(r.id),
        folder: folderOf(String(r.url), account) ?? '?',
        sender: String(r.name || r.address || 'unknown').replace(/\s*\(via [^)]*\)\s*$/i, ''),
        subject: `${r.prefix ? String(r.prefix) : ''}${String(r.subject ?? '')}`.trim() || '(no subject)',
        at: Number(r.at) * 1000,
        unread: Number(r.read) === 0,
        messageId: String(r.mid ?? '')
      })
    )
    snap.newestAt = snap.mails[0]?.at ?? null
    if (!snap.mails.length) snap.note = 'No unread Nova mail'
  } catch (err) {
    const msg = (err as Error).message
    snap.note = /authorization|not permitted|unable to open/i.test(msg)
      ? 'Orca cannot read Apple Mail: give Orca Full Disk Access (System Settings → Privacy & Security).'
      : `Could not read Apple Mail: ${msg.split('\n')[0]}`
  }
  return snap
}

// ---------- status bar ----------

export function countdown(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h} h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d} d ${rh} h` : `${d} d`
}

export function statusBarText(tasks: Pick<TaskItem, 'urgent' | 'dueAt' | 'course' | 'task' | 'dueRaw'>[], now: number): { text: string; tone: 'neutral' | 'warning' | 'danger'; tooltip: string } {
  const urgent = tasks.filter((t) => t.urgent).length
  const next = tasks.find((t) => t.dueAt !== null && t.dueAt > now)
  const parts = ['Nova']
  if (urgent) parts.push(`${urgent} urgent`)
  if (next?.dueAt) parts.push(`next in ${countdown(next.dueAt - now)}`)
  if (!urgent && !next) parts.push(`${tasks.length} open`)
  const left = next?.dueAt ? next.dueAt - now : Infinity
  const tone = left < 36 * 3600e3 ? 'danger' : left < 4 * 86400e3 || urgent ? 'warning' : 'neutral'
  const tooltip = next ? `Next: ${next.course} · ${next.task.slice(0, 90)} (${next.dueRaw})` : 'No dated open Nova tasks'
  return { text: parts.join(' · '), tone, tooltip }
}
