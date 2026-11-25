// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}
import type { CalendarGlance } from './calendar-bridge'
export type { CalendarGlance }

declare module 'orca' {
  interface PluginRequests {
    /** Reads the local files (read-only) and answers what today looks like. */
    'today.get': { output: TodaySnapshot }
    /** Open tasks from OD/TASKS.md (written by hand or by an optional sync), soonest first. */
    'tasks.get': { output: TasksSnapshot }
    /** The sections of one task pack (_PREP file) plus its _DRAFT files. */
    'pack.get': { input: { path: string }; output: PackDetail }
    /** Unread mails of the Nova account (auto-detected, @novasbe.pt) from Apple Mail's local index, newest first (max 100), read-only. */
    'mail.get': { output: MailSnapshot }
    /** Opens a task file or its folder (Finder) with macOS `open`. Only paths in the Nova OneDrive. */
    'file.open': { input: { path: string; reveal?: boolean }; output: { ok: boolean; error?: string } }
    /** Current and next timed event from the Calendar section (Mac calendars). */
    'calendar.glance': { output: CalendarGlance }
    /** The student's manual status for a task (null clears it). Stored in the plugin's own storage only. */
    'task.override': { input: { id: string; stage: TaskStage | null }; output: TasksSnapshot }
    /** Opens one message in Apple Mail by its Message-ID header. */
    'mail.open': { input: { messageId: string }; output: { ok: boolean; error?: string } }
  }
}

export interface ClassItem {
  start: string // "11:00"
  end: string // "12:30" or ""
  title: string
  room: string
}

export interface DeadlineItem {
  date: string // ISO yyyy-mm-dd
  label: string // "Wed 25 Nov"
  time: string
  course: string
  what: string
  urgent: boolean // ⚠️ in the sync file
  isNew: boolean // 🆕 in the sync file
  overdue: boolean // date before today
}

export interface TodaySnapshot {
  todayLabel: string
  classes: ClassItem[]
  classesSource: string // "Mac calendar “Nova SBE …”" or "OneDrive .ics (fallback)"

  classesNote: string // why the list may be empty or stale
  tomorrow: ClassItem[]
  deadlines: DeadlineItem[] // next 7 days, never overdue
  deadlinesUpdated: string // header line of DEADLINES.md
  deadlinesNote: string
  openItems: { overdue: number; urgent: number; dueThisWeek: number }
  readAt: number
}

/** Computed from evidence in the task folder each refresh (or the student's override in the panel). */
export type TaskStage = 'not-started' | 'prepared' | 'in-progress' | 'ready' | 'done'

export interface TaskItem {
  id: string // stable: course + task text
  key: string
  statusRaw: string // the Status cell in TASKS.md (the sync's snapshot), emoji included
  stage: TaskStage
  stageFrom: 'evidence' | 'override' | 'tasks.md'
  why: string // "based on …"
  lastEdit: { file: string; at: number } | null // newest non-pack file edited after the pack date
  override: TaskStage | null
  progress: number // 0-100, from the stage
  dueRaw: string // the Due cell as written
  dueAt: number | null // ms of the next date/time in the Due cell (Lisbon), null when no date
  course: string
  task: string
  urgent: boolean // 🔥 in the status
  nextStep: string // the pack's "Next step" line, '' when none
  link: { kind: 'pack' | 'draft' | 'none'; path: string; label: string } // label: Moodle / Mail / pack / draft
}

export interface TasksSnapshot {
  tasks: TaskItem[] // open only: not done (by evidence, override or TASKS.md), not passed or overdue
  hidden: number // rows left out (done, passed or overdue)
  updated: string // "Updated 25 Nov 2026 09:04 · …" line
  note: string
  readAt: number
}

export interface PackSection {
  title: string
  body: string // markdown
}

export interface PackDetail {
  path: string
  title: string
  sections: PackSection[] // in the order the panel shows them
  drafts: { name: string; path: string }[]
  note: string // e.g. "not synced"
}

export interface MailItem {
  id: number
  folder: string // "Inbox", "1 Courses", …
  sender: string
  subject: string
  at: number // ms
  unread: boolean
  messageId: string // "<…>" header, "" when unknown
}

export interface MailSnapshot {
  account: string
  folders: { name: string; total: number; unread: number }[]
  mails: MailItem[] // unread only, newest first, max 100
  unreadTotal: number // all unread in inbox + the 5 rule folders
  newestAt: number | null
  note: string
  readAt: number
}
