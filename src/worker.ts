// The Today panel's worker. Read-only: it only reads two local files and never writes,
// sends or deletes anything.
//   - Nova class schedule: the Mac calendar named "Nova SBE …"; fallback the first .ics export
//     (by name) in <Nova OneDrive>/SCHEDULE_DIR.
//   - Deadlines: OD/DEADLINES.md, written by your own sync or by hand (see README).
// OneDrive files can be cloud-only ("dataless"): every read has a timeout and the panel says
// "not synced" instead of hanging.
import type { OrcaWorkerApi } from 'orca/worker'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClassItem, DeadlineItem, TodaySnapshot } from './protocol'
import { calendarGlance, startCalendar } from './calendar-bridge'
import { OD, lisbonMs, mailSnapshot, openFile, openMail, packDetail, setOverride, statusBarText, tasksSnapshot, type OverrideStore } from './nova'
// @ts-ignore: plain ESM from the Calendar plugin (MIT, Bautista Pessagno)
import { createEventKitBackend } from '../calendar/backends/eventkit/backend.mjs'

/** Fallback class schedule: a .ics export in this folder of the Nova OneDrive (see README). */
export const SCHEDULE_DIR = '1 Admin/6 Academic Calendar'
const ICS_DIRS = [join(OD, SCHEDULE_DIR)]
const DEADLINES = join(OD, 'DEADLINES.md')
const READ_TIMEOUT_MS = 8000
const TZ = 'Europe/Lisbon'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

class ReadTimeout extends Error {}

async function readText(path: string): Promise<string> {
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

/** Today's date in Lisbon as yyyy-mm-dd. */
function lisbonToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function label(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

// ---------- classes (.ics) ----------

interface IcsEvent { date: string; start: string; end: string; title: string; room: string }

async function findIcs(): Promise<string | null> {
  for (const dir of ICS_DIRS) {
    try {
      const hits = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.ics')).sort()
      if (hits.length) return join(dir, hits[0])
    } catch {
      // folder missing: try the next one
    }
  }
  return null
}

function parseIcs(raw: string): IcsEvent[] {
  const text = raw.replace(/\r\n /g, '').replace(/\n /g, '')
  const out: IcsEvent[] = []
  for (const m of text.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const block = m[1]
    const field = (name: string): string => {
      const f = block.match(new RegExp(`^${name}[^:\\n]*:(.*)$`, 'm'))
      return f ? f[1].trim() : ''
    }
    const ds = block.match(/DTSTART[^:]*:(\d{8})T(\d{6})/)
    if (!ds) continue
    const de = block.match(/DTEND[^:]*:(\d{8})T(\d{6})/)
    const iso = `${ds[1].slice(0, 4)}-${ds[1].slice(4, 6)}-${ds[1].slice(6, 8)}`
    const hhmm = (t: string) => `${t.slice(0, 2)}:${t.slice(2, 4)}`
    out.push({
      date: iso,
      start: hhmm(ds[2]),
      end: de ? hhmm(de[2]) : '',
      title: field('SUMMARY').replace(/\\,/g, ',').split(' · ')[0],
      room: field('LOCATION').replace(/\\,/g, ',').split(',')[0].trim()
    })
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
}

// ---------- deadlines (DEADLINES.md) ----------

function parseDeadlines(md: string, today: string): { items: DeadlineItem[]; updated: string } {
  const updated = (md.match(/^Updated [^\n]*/m)?.[0] ?? '').split('.')[0]
  const year = Number(today.slice(0, 4))
  const todayMonth = Number(today.slice(5, 7))
  const horizon = addDays(today, 7)
  const items: DeadlineItem[] = []
  // Only the "Due in the next 21 days" table: stop at the next heading after it.
  const section = md.split(/^## /m).find((s) => s.startsWith('Due')) ?? md
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---') || line.startsWith('| Date')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 5) continue
    const [dateCell, , time, course, whatRaw] = cells
    const dm = dateCell.match(/(\d{1,2})\s+([A-Za-z]{3})/)
    if (!dm) continue
    const month = MONTHS.indexOf(dm[2].slice(0, 1).toUpperCase() + dm[2].slice(1, 3).toLowerCase()) + 1
    if (month === 0) continue
    // Year wrap: a January date read in December belongs to next year, and the reverse.
    let y = year
    if (todayMonth === 12 && month === 1) y = year + 1
    if (todayMonth === 1 && month === 12) y = year - 1
    const iso = `${y}-${String(month).padStart(2, '0')}-${dm[1].padStart(2, '0')}`
    const urgent = whatRaw.includes('⚠️')
    const isNew = whatRaw.includes('🆕')
    const overdue = iso < today
    if (iso > horizon) continue
    if (overdue) continue // overdue items are never shown
    let what = whatRaw.replace(/⚠️|🆕/g, '').replace(/`[^`]*`/g, '').replace(/\s*Pack:\s*\.?/g, ' ').replace(/\s+/g, ' ').trim()
    if (what.length > 140) what = what.slice(0, 137).trimEnd() + '…'
    items.push({ date: iso, label: label(iso), time, course, what, urgent, isNew, overdue })
  }
  return { items, updated }
}

// ---------- classes from the Mac calendar (EventKit) ----------

const eventKit = createEventKitBackend()
const NOVA_CALENDAR = /^nova sbe/i

function lisbonParts(ms: number): { date: string; hhmm: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? ''
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${g('hour')}:${g('minute')}` }
}

/** Today's and tomorrow's classes from the Mac calendar named "Nova SBE …"; null when unavailable. */
async function classesFromMac(today: string): Promise<{ events: IcsEvent[]; calendar: string } | null> {
  try {
    const cals = (await eventKit.calendars()) as { id: string; title: string }[]
    const nova = cals.filter((c) => NOVA_CALENDAR.test(c.title))
    if (!nova.length) return null
    const [y, m, d] = today.split('-').map(Number)
    const from = lisbonMs(y, m, d, 0, 0)
    const raw = (await eventKit.events({ from, to: from + 2 * 86400e3 + 3600e3, calendars: nova })) as { allDay: boolean; start: number; end: number; title: string; location: string | null; room: string | null }[]
    const events = raw
      .filter((e) => !e.allDay)
      .map((e) => {
        const s = lisbonParts(e.start)
        return { date: s.date, start: s.hhmm, end: lisbonParts(e.end).hhmm, title: e.title.split(' · ')[0], room: (e.location || e.room || e.title.split(' · ')[1] || '').split(',')[0].trim() }
      })
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    return { events, calendar: nova.map((c) => c.title).join(', ') }
  } catch {
    return null
  }
}

// ---------- snapshot ----------

async function snapshot(): Promise<TodaySnapshot> {
  const today = lisbonToday()
  const tomorrowIso = addDays(today, 1)
  const snap: TodaySnapshot = {
    todayLabel: new Date(today + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    classes: [],
    classesSource: '',
    classesNote: '',
    tomorrow: [],
    deadlines: [],
    deadlinesUpdated: '',
    deadlinesNote: '',
    openItems: { overdue: 0, urgent: 0, dueThisWeek: 0 },
    readAt: Date.now()
  }

  const pick = (events: IcsEvent[], d: string): ClassItem[] =>
    events.filter((e) => e.date === d).map(({ start, end, title, room }) => ({ start, end, title, room }))
  const mac = await classesFromMac(today)
  if (mac) {
    snap.classes = pick(mac.events, today)
    snap.tomorrow = pick(mac.events, tomorrowIso)
    snap.classesSource = `Mac calendar “${mac.calendar}”`
    if (!snap.classes.length) snap.classesNote = 'No classes today.'
  } else {
    snap.classesSource = 'OneDrive .ics (fallback: the Mac calendar could not be read)'
    try {
      const ics = await findIcs()
      if (!ics) {
        snap.classesNote = `No Nova .ics found in ${SCHEDULE_DIR}. Export a fresh schedule from the Nova portal.`
      } else {
        const events = parseIcs(await readText(ics))
        snap.classes = pick(events, today)
        snap.tomorrow = pick(events, tomorrowIso)
        const last = events.at(-1)?.date
        if (!snap.classes.length) {
          snap.classesNote = last && today > last ? `The calendar export ends ${label(last)}: time for a fresh export.` : 'No classes today.'
        }
      }
    } catch (err) {
      snap.classesNote = err instanceof ReadTimeout ? 'Schedule not synced (OneDrive file is cloud-only). Open the folder in Finder to download it.' : `Could not read the schedule: ${(err as Error).message}`
    }
  }

  try {
    const { items, updated } = parseDeadlines(await readText(DEADLINES), today)
    snap.deadlines = items
    snap.deadlinesUpdated = updated
    snap.openItems = {
      overdue: items.filter((d) => d.overdue).length,
      urgent: items.filter((d) => d.urgent && !d.overdue).length,
      dueThisWeek: items.filter((d) => !d.overdue).length
    }
    if (!items.length) snap.deadlinesNote = 'Nothing due in the next 7 days.'
  } catch (err) {
    snap.deadlinesNote = err instanceof ReadTimeout ? 'DEADLINES.md not synced (OneDrive file is cloud-only).' : (err as { code?: string }).code === 'ENOENT' ? 'No DEADLINES.md yet in your Nova OneDrive (format: see README).' : `Could not read DEADLINES.md: ${(err as Error).message}`
  }

  return snap
}

const STATUS_EVERY_MS = 5 * 60 * 1000

function overrideStore(orca: OrcaWorkerApi): OverrideStore {
  return {
    get: (k) => orca.storage.get(k),
    set: (k, v) => orca.storage.set(k, v as never),
    delete: (k) => orca.storage.delete(k)
  }
}

async function updateStatusBar(orca: OrcaWorkerApi): Promise<void> {
  try {
    const snap = await tasksSnapshot(overrideStore(orca))
    const s = snap.note && !snap.tasks.length
      ? { text: 'Nova · ' + (snap.note.includes('not synced') ? 'not synced' : 'no open tasks'), tone: 'neutral' as const, tooltip: snap.note }
      : statusBarText(snap.tasks, Date.now())
    await orca.host.call('statusBar.update', { id: 'nova-status', text: s.text, tone: s.tone, tooltip: s.tooltip, icon: 'calendar' })
  } catch (err) {
    orca.log(`status bar update failed: ${(err as Error).message}`)
  }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('today.get', async () => snapshot())
  orca.panels.handle('tasks.get', async () => {
    const snap = await tasksSnapshot(overrideStore(orca))
    void updateStatusBar(orca)
    return snap
  })
  orca.panels.handle('pack.get', async (input) => packDetail(input.path))
  orca.panels.handle('mail.get', async () => mailSnapshot())
  orca.panels.handle('file.open', async (input) => openFile(input.path, input.reveal === true))
  orca.panels.handle('mail.open', async (input) => openMail(input.messageId))
  orca.panels.handle('calendar.glance', async () => calendarGlance())
  orca.panels.handle('task.override', async (input) => {
    await setOverride(overrideStore(orca), input.id, input.stage)
    const snap = await tasksSnapshot(overrideStore(orca))
    void updateStatusBar(orca)
    return snap
  })
  void startCalendar(orca).catch((err: Error) => orca.log(`calendar start failed: ${err.message}`))
  void updateStatusBar(orca)
  const timer = setInterval(() => void updateStatusBar(orca), STATUS_EVERY_MS)
  timer.unref?.()
}

// Exported for tests.
export { parseDeadlines, parseIcs }
