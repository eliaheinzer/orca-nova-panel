// Runs the Calendar plugin's worker (MIT, © 2026 Bautista Pessagno, copied unchanged into
// ../calendar, see THIRD_PARTY_LICENSES/calendar-LICENSE) inside the Nova worker, so the Nova
// plugin's "Calendar" panel is the original panel with the original look.
//
// Differences from the original plugin, all by what it is handed here (its code is untouched):
//   - Backend: the Mac's calendars (EventKit) and the sample week only. No Google login here.
//   - No reminders and no second status bar item: the installed Calendar plugin already does both,
//     so those host calls are answered without doing anything.
//   - Its settings live in Nova's own storage (keys prefixed `cal.`), with Nova's defaults.
import type { OrcaWorkerApi } from 'orca/worker'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore: plain ESM from the Calendar plugin
import activateCalendar from '../calendar/worker.mjs'
// @ts-ignore: plain ESM from the Calendar plugin
import { createEventKitBackend } from '../calendar/backends/eventkit/backend.mjs'
// @ts-ignore: plain ESM from the Calendar plugin
import { createSampleBackend, createSampleTasks } from '../calendar/backends/sample.mjs'
// @ts-ignore: plain ESM from the Calendar plugin
import { meetingState } from '../calendar/shared/agenda.mjs'

const PREFIX = 'cal.'
const SETTINGS_KEY = 'cal.settings'
const DEFAULTS: Record<string, unknown> = {
  backend: 'eventkit',
  days: 3,
  notify: false,
  notifyMinutes: 5,
  showDeclined: false,
  rsvp: false,
  completeTasks: false
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Listener = (change: { key: string }) => void

export interface CalendarEventLite {
  title: string
  start: number
  end: number
  location: string | null
  color: string
}

export interface CalendarGlance {
  status: string
  message: string
  current: CalendarEventLite | null
  next: CalendarEventLite | null
  fetchedAt: number | null
}

let agendaGet: ((input?: unknown) => Promise<unknown>) | null = null

function lite(e: Record<string, unknown> | null): CalendarEventLite | null {
  if (!e) return null
  return { title: String(e.title ?? ''), start: Number(e.start), end: Number(e.end), location: (e.location as string) ?? (e.room as string) ?? null, color: String(e.color ?? '') }
}

/** Current and next timed event, as the Calendar's own status bar picks them. */
export async function calendarGlance(): Promise<CalendarGlance> {
  if (!agendaGet) return { status: 'error', message: 'Calendar is not running.', current: null, next: null, fetchedAt: null }
  try {
    const snap = (await agendaGet({})) as { status: string; message?: string; events?: Record<string, unknown>[]; fetchedAt?: number }
    const { current, next } = meetingState(snap.events ?? [], Date.now(), { showDeclined: false })
    return { status: snap.status, message: snap.message ?? '', current: lite(current), next: lite(next), fetchedAt: snap.fetchedAt ?? null }
  } catch (err) {
    return { status: 'error', message: (err as Error).message, current: null, next: null, fetchedAt: null }
  }
}

// The installed Calendar plugin's own store: read once (read-only) so the Nova copy starts with the
// same calendars shown and hidden as picked there.
const ORIGINAL_STORE = join(homedir(), 'Library/Application Support/orca/plugins-data/bautistapessagno.calendar/storage.json')

async function adoptOriginalChoices(orca: OrcaWorkerApi): Promise<void> {
  if ((await orca.storage.get(PREFIX + 'calendars')) !== null) return
  try {
    const original = JSON.parse(await readFile(ORIGINAL_STORE, 'utf8')) as { calendars?: Json }
    if (original.calendars && typeof original.calendars === 'object') await orca.storage.set(PREFIX + 'calendars', original.calendars)
  } catch {
    // No original plugin or no choices: every calendar but birthdays shows, as in the original.
  }
}

export async function startCalendar(orca: OrcaWorkerApi): Promise<void> {
  await adoptOriginalChoices(orca)
  const listeners = new Set<Listener>()
  const readSettings = async (): Promise<Record<string, unknown>> => ({ ...DEFAULTS, ...(((await orca.storage.get(SETTINGS_KEY)) as Record<string, unknown> | null) ?? {}) })
  const settings = {
    get: async (key?: string) => (key === undefined ? readSettings() : (await readSettings())[key]),
    set: async (key: string, value: Json) => {
      await orca.storage.set(SETTINGS_KEY, { ...(await readSettings()), [key]: value } as Json)
      for (const l of listeners) l({ key })
    },
    onDidChange: (l: Listener) => {
      listeners.add(l)
      return { dispose: () => listeners.delete(l) }
    }
  }
  const storage = {
    get: (key: string) => orca.storage.get(PREFIX + key),
    set: (key: string, value: Json) => orca.storage.set(PREFIX + key, value),
    delete: (key: string) => orca.storage.delete(PREFIX + key),
    keys: async () => (await orca.storage.keys()).filter((k) => k.startsWith(PREFIX) && k !== SETTINGS_KEY).map((k) => k.slice(PREFIX.length)),
    onDidChange: () => ({ dispose: () => undefined })
  }
  const host = {
    call: async (method: string, params?: unknown) => {
      // The installed Calendar plugin keeps its own status bar countdown and reminders.
      if (method === 'statusBar.update' || method === 'notifications.show') return { ok: true }
      if (method === 'secrets.protection') return { status: 'unavailable' }
      return (orca.host.call as (m: string, p?: unknown) => Promise<unknown>)(method, params)
    },
    has: () => false
  }
  const noGoogle = Object.assign(new Error('Google sign-in is not part of the Nova panel: it shows your Mac’s calendars. Use the Calendar plugin to connect Google.'), { code: 'unsupported' })
  const auth = {
    connection: async () => ({ connected: false, clientId: null, tasks: 'none', rsvp: false }),
    start: async () => {
      throw noGoogle
    },
    status: async () => ({ status: 'idle' }),
    disconnect: async () => undefined,
    close: () => undefined
  }
  const panels = {
    handle: (name: string, handler: (input?: unknown) => Promise<unknown>) => {
      if (name === 'agenda.get') agendaGet = handler
      return (orca.panels.handle as (n: string, h: (input?: unknown) => Promise<unknown>) => unknown)(name, handler)
    },
    post: (event: string, payload: unknown) => (orca.panels.post as (e: string, p: unknown) => unknown)(event, payload)
  }
  activateCalendar(
    { log: (m: string) => orca.log(`[calendar] ${m}`), host, settings, storage, secrets: null, panels },
    {
      auth,
      backends: { eventkit: createEventKitBackend(), sample: createSampleBackend({ now: Date.now }) },
      taskSources: { sample: createSampleTasks({ now: Date.now }) }
    }
  )
}
