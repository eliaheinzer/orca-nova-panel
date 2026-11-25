// Nova panel: a daily dashboard plus sections (Calendar, Tasks, Today, Mail). Runs on the same page as
// the Calendar plugin's original agenda (calendar/panel/nova.html = its index.html + this), which it
// shows unchanged in the Calendar section. Read-only: every action asks Nova's worker.
import { buildAgenda, meetingState } from '../calendar/shared/agenda.mjs'
import { formatDuration, formatTime, where } from '../calendar/shared/format.mjs'
import { draw } from '../calendar/panel/draw.mjs'
import { classGlance, countdown, esc, lisbonHHMM, markdown, short, timeTone } from './view.mjs'

const $ = (id) => document.getElementById(id)
const view = $('nv-view')
const tabsEl = $('nv-tabs')
const calHeader = document.querySelector('header.top')
const calMain = $('main')
const locale = (globalThis.orca && orca.locale) || undefined
const time = (ms) => formatTime(ms, { locale })

const STAGES = [
  ['not-started', '⚪', 'Not started'],
  ['prepared', '🔵', 'Prepared'],
  ['in-progress', '🟡', 'In progress'],
  ['ready', '🟢', 'Ready to submit'],
  ['done', '✅', 'Done']
]
const stageInfo = (s) => STAGES.find((x) => x[0] === s) ?? STAGES[0]
const TABS = [
  ['dashboard', 'Today'],
  ['calendar', 'Calendar'],
  ['tasks', 'Tasks'],
  ['classes', 'Classes'],
  ['mail', 'Mail']
]

let tab = 'dashboard'
try {
  tab = localStorage.getItem('nv-tab') || 'dashboard'
} catch {}
if (!TABS.some((t) => t[0] === tab)) tab = 'dashboard'
const data = { today: null, tasks: null, mail: null, agenda: null, errors: {} }
const packs = new Map() // path -> detail | 'loading'
let openTask = null
let mailFilter = 'All'
let busy = false

const req = (name, input) => (input === undefined ? orca.plugin.request(name) : orca.plugin.request(name, input))

async function loadAll(attempt = 0) {
  busy = true
  render()
  const jobs = { today: req('today.get'), tasks: req('tasks.get'), mail: req('mail.get'), agenda: req('agenda.get') }
  await Promise.all(
    Object.entries(jobs).map(([k, p]) =>
      p.then(
        (v) => ((data[k] = v), delete data.errors[k]),
        (e) => (data.errors[k] = e?.message || String(e))
      )
    )
  )
  busy = false
  // The worker restarts after an update or an idle stop: try once more instead of showing the error.
  if (attempt < 2 && Object.values(data.errors).some((m) => /disconnected|not running|unavailable|starting/i.test(m))) {
    return void setTimeout(() => loadAll(attempt + 1), 1500)
  }
  render()
}

function setTab(next) {
  tab = next
  try {
    localStorage.setItem('nv-tab', tab)
  } catch {}
  window.scrollTo(0, 0)
  render()
}

// ---------- shared bits ----------

const pill = (dueAt, now) => `<span class="nv-pill ${timeTone(dueAt, now) === 'none' ? '' : timeTone(dueAt, now)}">${dueAt == null ? 'no date' : esc(countdown(dueAt - now))}</span>`
const bar = (t, now) => `<div class="nv-bar ${timeTone(t.dueAt, now) === 'none' ? '' : timeTone(t.dueAt, now)}" title="${esc(stageInfo(t.stage)[2])} · ${t.progress}%"><span style="width:${t.progress}%"></span></div>`
const backLink = () => `<button class="nv-back" data-nv-tab="dashboard">‹ Today</button>`
const refreshBtn = () =>
  `<button class="nv-icon-btn${busy ? ' spin' : ''}" data-nv-refresh="1" title="Refresh" aria-label="Refresh"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
const errorBanner = (k) => (data.errors[k] ? `<div class="nv-banner">${esc(data.errors[k])}</div>` : '')

function stageLine(t) {
  const [, dot, label] = stageInfo(t.stage)
  const edit = t.lastEdit ? ` · last edited ${esc(new Date(t.lastEdit.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' }))} ${esc(short(t.lastEdit.file, 40))}` : ''
  return `<div class="nv-stage"><b>${dot} ${esc(label)}</b>${t.override ? '<span class="nv-ov">set by you</span>' : ''}<span>based on ${esc(t.why)}${edit}</span></div>`
}

// ---------- the day's schedule, drawn with the Calendar's own markup and CSS ----------

const COLOR = /^#[0-9a-f]{6}$/i
const safeColor = (v) => (COLOR.test(v ?? '') ? v : '#039be5')

function scheduleHTML(now) {
  const snap = data.agenda
  if (!snap) return data.errors.agenda ? `<div class="nv-empty">${esc(data.errors.agenda)}</div>` : '<div class="nv-empty">Loading your calendar…</div>'
  if (snap.status !== 'ready' && !(snap.events || []).length) return `<div class="nv-empty">${esc(snap.message || snap.status)}</div>`
  const agenda = buildAgenda(snap.events || [], { now, days: 1, showDeclined: snap.showDeclined, tasks: [] })
  const { current, next } = meetingState(snap.events || [], now)
  const html = []
  const soonNext = next && next.start - now <= 5 * 60_000
  const ev = soonNext ? next : current || next
  if (ev && (current || ev.start - now <= 12 * 3600_000)) {
    const running = ev === current && !soonNext
    const label = running ? `Now · ends in ${formatDuration(ev.end - now)}` : `${ev.start - now <= 5 * 60_000 ? 'Starting' : 'Next'} in ${formatDuration(ev.start - now)}`
    const cls = running ? 'now' : ev.start - now <= 5 * 60_000 ? 'soon' : ''
    const meta = [`${time(ev.start)} – ${time(ev.end)}`, where(ev)].filter(Boolean).join(' · ')
    html.push(`<section class="next"><span class="bar" style="background:${safeColor(ev.color)}"></span><div style="min-width:0"><div class="label ${cls} tabular">${esc(label)}</div><div class="title">${esc(ev.title)}</div><div class="meta tabular">${esc(meta)}</div></div></section>`)
  }
  const day = agenda.days[0]
  if (day) {
    const d = new Date(now)
    html.push(`<div class="agenda"><section class="day today"><div class="date"><span class="dow">${esc(new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d))}</span><span class="num tabular">${d.getDate()}</span></div><div class="items">`)
    for (const e of day.allDay) html.push(`<button class="chip" style="background:${safeColor(e.color)}" data-nv-tab="calendar" title="${esc(e.title)}">${esc(e.title)}</button>`)
    const timed = day.items.filter((i) => i.type === 'event')
    if (!timed.length && !day.allDay.length) html.push('<div class="empty-day">Nothing else today</div>')
    for (const item of day.items) {
      if (item.type === 'now') {
        if (timed.length) html.push(`<div class="now-line" role="presentation"><span class="tabular">${esc(time(item.at))}</span></div>`)
      } else if (item.type === 'gap') {
        html.push(`<div class="gap tabular"><span>${esc(formatDuration(item.end - item.start))} free until ${esc(time(item.end))}</span></div>`)
      } else {
        const e = item.event
        const cls = ['event']
        if (agenda.current.includes(e.id)) cls.push('current')
        else if (e.end <= now) cls.push('past')
        if (e.busy === false) cls.push('free')
        const when = [`${item.continued ? '…' : time(e.start)} – ${item.continues ? '…' : time(e.end)}`, where(e)].filter(Boolean).join(' · ')
        html.push(`<div class="${cls.join(' ')}" style="--c:${safeColor(e.color)}"><span class="dot"></span><button class="what" data-nv-tab="calendar"><div class="title">${esc(e.title)}</div><div class="when tabular">${esc(when)}</div></button><div class="side">${agenda.current.includes(e.id) ? '<span class="badge">Now</span>' : ''}</div></div>`)
      }
    }
    html.push('</div></section></div>')
  }
  return `<div class="nv-sched">${html.join('')}</div>`
}

// ---------- dashboard ----------

function dashboard(now) {
  const d = data.today
  const t = data.tasks
  const m = data.mail
  const hour = Number(lisbonHHMM(now).slice(0, 2))
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const tasks = t?.tasks ?? []
  const due48 = tasks.filter((x) => x.dueAt != null && x.dueAt - now <= 48 * 3600e3)
  const urgentCount = due48.filter((x) => x.dueAt - now < 36 * 3600e3).length
  const classes = d ? classGlance(d.classes, lisbonHHMM(now)) : null
  const summary = [
    classes ? (classes.left ? `${classes.left} class${classes.left === 1 ? '' : 'es'} left` : 'no more classes') : null,
    t ? `${due48.length} due in 48 h` : null,
    m ? `${m.unreadTotal} unread` : null
  ].filter(Boolean).join(' · ')

  const doToday = [...tasks]
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
    .slice(0, 3)

  // this week: deadlines per day (DEADLINES.md, next 7 days) + dated open tasks, deduplicated by day/course
  const week = []
  for (let i = 0; i < 7; i++) {
    const day = new Date(now + i * 86400e3)
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(day)
    const items = new Map()
    for (const x of d?.deadlines ?? []) if (x.date === iso) items.set(`${x.course}|${x.what}`, timeTone(Date.parse(iso + 'T23:59:00Z'), now))
    for (const x of tasks) {
      if (x.dueAt == null) continue
      const di = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(x.dueAt))
      if (di === iso) items.set(`${x.course}|${x.task}`, timeTone(x.dueAt, now))
    }
    week.push({ day, iso, dots: [...items.values()].slice(0, 4), count: items.size })
  }

  return `
    <div class="nv-head"><h1>${esc(new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Lisbon' }).format(new Date(now)))}</h1>${refreshBtn()}</div>
    <div class="nv-greet">${esc(greet)}${summary ? ' · ' + esc(summary) : ''}</div>

    <section class="nv-section">
      <div class="nv-title">Schedule<button class="nv-more" data-nv-tab="calendar">Calendar ›</button></div>
      <div class="nv-card">${scheduleHTML(now)}</div>
    </section>

    <section class="nv-section">
      <div class="nv-title">Due today &amp; next 48 h${urgentCount ? ` · ${urgentCount} urgent` : ''}<button class="nv-more" data-nv-tab="tasks">Tasks ›</button></div>
      <div class="nv-card nv-rows">${
        t
          ? due48.length
            ? due48.map((x) => `<button class="nv-row" data-nv-task="${esc(x.id)}"><div class="nv-line"><span class="nv-t">${esc(short(x.task, 90))}</span>${pill(x.dueAt, now)}</div><div class="nv-s">${esc(x.course)}</div>${bar(x, now)}</button>`).join('')
            : '<div class="nv-empty">Nothing due in the next 48 hours.</div>'
          : errorBanner('tasks') || '<div class="nv-empty">Loading…</div>'
      }</div>
    </section>

    <section class="nv-section">
      <div class="nv-title">Do today</div>
      <div class="nv-card nv-rows">${
        doToday.length
          ? doToday.map((x) => `<button class="nv-row" data-nv-task="${esc(x.id)}"><div class="nv-line"><span class="nv-t">${esc(x.course)}</span>${pill(x.dueAt, now)}</div><div class="nv-s wrap">${esc(short(x.nextStep || x.task, 150))}</div></button>`).join('')
          : `<div class="nv-empty">${t ? 'No open tasks.' : 'Loading…'}</div>`
      }</div>
    </section>

    <section class="nv-section">
      <div class="nv-title">Mail${m ? ` · ${m.unreadTotal} unread` : ''}<button class="nv-more" data-nv-tab="mail">Mail ›</button></div>
      <div class="nv-card nv-rows">${
        m
          ? m.mails.length
            ? m.mails.slice(0, 3).map((x) => `<button class="nv-row" data-nv-mail="${esc(x.messageId)}"><div class="nv-line"><span class="nv-unread"></span><span class="nv-t">${esc(short(x.subject, 90))}</span></div><div class="nv-s">${esc(x.folder)} · ${esc(x.sender)}</div></button>`).join('')
            : `<div class="nv-empty">${esc(m.note || 'No unread Nova mail')}</div>`
          : errorBanner('mail') || '<div class="nv-empty">Loading…</div>'
      }</div>
    </section>

    <section class="nv-section">
      <div class="nv-title">This week</div>
      <div class="nv-card"><div class="nv-week">${week
        .map((w, i) => `<button class="nv-wd${i === 0 ? ' today' : ''}" data-nv-tab="tasks" title="${w.count} deadline${w.count === 1 ? '' : 's'}"><span class="d">${esc(new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/Lisbon' }).format(w.day))}</span><span class="n">${esc(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Lisbon' }).format(w.day))}</span><span class="dots">${w.dots.map((c) => `<i class="${c}"></i>`).join('')}</span></button>`)
        .join('')}</div></div>
    </section>`
}

// ---------- tasks ----------

function packHTML(t) {
  const p = packs.get(t.link.path)
  if (!p || p === 'loading') return '<div class="nv-pack">Reading the pack…</div>'
  const parts = []
  if (p.note) parts.push(`<p>${esc(p.note)}</p>`)
  for (const s of p.sections) parts.push(`<h3>${esc(s.title)}</h3><div>${markdown(s.body)}</div>`)
  if (p.drafts.length) parts.push(`<h3>Drafts (${p.drafts.length})</h3><div class="nv-btns">${p.drafts.map((d) => `<button class="nv-btn" data-nv-file="${esc(d.path)}">${esc(short(d.name, 50))}</button>`).join('')}</div>`)
  parts.push(`<div class="nv-btns"><button class="nv-btn primary" data-nv-file="${esc(t.link.path)}">${t.link.kind === 'draft' ? 'Open draft' : 'Open pack'}</button><button class="nv-btn" data-nv-reveal="${esc(t.link.path)}">Open folder</button></div>`)
  return `<div class="nv-pack">${parts.join('')}</div>`
}

function taskHTML(t, now) {
  const opts = [['', 'Auto (from files)'], ...STAGES.map(([v, dot, l]) => [v, `${dot} ${l}`])]
  const open = openTask === t.id
  return `<div class="nv-task" id="nv-task-${esc(t.id)}">
    <div class="nv-line" style="display:flex;gap:8px;align-items:baseline"><span class="nv-t" style="flex:1;font-weight:600;font-size:13px">${esc(short(t.task, 140))}</span>${pill(t.dueAt, now)}</div>
    <div class="nv-s" style="font-size:12px;color:var(--muted)">${esc(t.course)} · due ${esc(short(t.dueRaw, 70))}</div>
    ${bar(t, now)}
    ${stageLine(t)}
    <div class="nv-tools">
      ${t.link.kind === 'none' ? `<span class="nv-s" style="font-size:12px;color:var(--muted)">No pack yet · requirements on ${esc(t.link.label)}</span>` : `<button class="nv-open-btn" data-nv-toggle="${esc(t.id)}">${open ? '▾' : '▸'} Guidelines, requirements &amp; plan</button>`}
      <select data-nv-override="${esc(t.id)}" title="Set the status yourself (kept until the sync changes this task)">${opts.map(([v, l]) => `<option value="${v}"${(t.override ?? '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </div>
    ${open && t.link.kind !== 'none' ? packHTML(t) : ''}
  </div>`
}

function tasksView(now) {
  const t = data.tasks
  const tasks = t?.tasks ?? []
  const count = (s) => tasks.filter((x) => x.stage === s).length
  return `
    ${backLink()}
    <div class="nv-head"><h2>Tasks${t ? ` · ${tasks.length} open` : ''}</h2>${refreshBtn()}</div>
    ${errorBanner('tasks')}
    ${t ? `<div class="nv-src">${STAGES.filter(([s]) => s !== 'done').map(([s, dot, l]) => `${dot} ${count(s)} ${esc(l.toLowerCase())}`).join(' · ')} · ${t.hidden} done/passed hidden</div>` : ''}
    <div class="nv-card">${t ? (tasks.length ? tasks.map((x) => taskHTML(x, now)).join('') : `<div class="nv-empty">${esc(t.note || 'No open tasks.')}</div>`) : '<div class="nv-empty">Loading…</div>'}</div>
    ${t?.updated ? `<div class="nv-src">TASKS.md: ${esc(short(t.updated, 160))}. Status is re-checked from each task folder on every refresh.</div>` : ''}`
}

// ---------- classes (Today section) ----------

function classesView() {
  const d = data.today
  if (!d) return `${backLink()}${errorBanner('today') || '<div class="nv-empty">Loading…</div>'}`
  const row = (c) => `<div class="nv-row"><div class="nv-line"><span class="nv-t">${esc(c.title)}</span><span class="nv-pill">${esc(c.start)}${c.end ? '–' + esc(c.end) : ''}</span></div><div class="nv-s">${esc(c.room || 'room not set')}</div></div>`
  return `
    ${backLink()}
    <div class="nv-head"><h2>${esc(d.todayLabel)}</h2>${refreshBtn()}</div>
    <section class="nv-section"><div class="nv-title">Classes today</div>
      <div class="nv-card nv-rows">${d.classes.length ? d.classes.map(row).join('') : `<div class="nv-empty">${esc(d.classesNote || 'No classes today.')}</div>`}</div>
      ${d.tomorrow.length ? `<div class="nv-src">Tomorrow: ${d.tomorrow.map((c) => `${esc(c.start)} ${esc(c.title)}`).join(' · ')}</div>` : ''}
      <div class="nv-src">Source: ${esc(d.classesSource || '—')}</div>
    </section>
    <section class="nv-section"><div class="nv-title">Deadlines, next 7 days</div>
      <div class="nv-card nv-rows">${d.deadlines.length ? d.deadlines.map((x) => `<div class="nv-row"><div class="nv-line"><span class="nv-t">${esc(x.course)}${x.isNew ? ' · new' : ''}</span><span class="nv-pill ${x.urgent ? 'red' : ''}">${esc(x.label)}${x.time ? ' ' + esc(x.time) : ''}</span></div><div class="nv-s wrap">${esc(x.what)}</div></div>`).join('') : `<div class="nv-empty">${esc(d.deadlinesNote || 'Nothing due in the next 7 days.')}</div>`}</div>
      ${d.deadlinesUpdated ? `<div class="nv-src">${esc(d.deadlinesUpdated)}</div>` : ''}
    </section>`
}

// ---------- mail ----------

function mailView() {
  const m = data.mail
  if (!m) return `${backLink()}${errorBanner('mail') || '<div class="nv-empty">Loading…</div>'}`
  const chips = [['All', m.unreadTotal], ...m.folders.filter((f) => f.unread > 0).map((f) => [f.name, f.unread])]
  const shown = mailFilter === 'All' ? m.mails : m.mails.filter((x) => x.folder === mailFilter)
  const when = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' })
  return `
    ${backLink()}
    <div class="nv-head"><h2>Mail · ${m.unreadTotal} unread</h2>${refreshBtn()}</div>
    <div class="nv-src">${esc(m.account)} · inbox and rule folders · unread only</div>
    ${m.unreadTotal ? `<div class="nv-chips">${chips.map(([n, c]) => `<button class="nv-chip" data-nv-filter="${esc(n)}" aria-pressed="${n === mailFilter}">${esc(n)} ${c}</button>`).join('')}</div>` : ''}
    <div class="nv-card nv-rows">${shown.length ? shown.map((x) => `<button class="nv-row" data-nv-mail="${esc(x.messageId)}"><div class="nv-line"><span class="nv-unread"></span><span class="nv-t">${esc(short(x.subject, 110))}</span></div><div class="nv-s">${esc(x.folder)} · ${esc(x.sender)} · ${esc(when(x.at))}</div></button>`).join('') : `<div class="nv-empty">${esc(m.note || 'No unread Nova mail')}</div>`}</div>
    ${m.mails.length >= 100 ? '<div class="nv-src">Showing the newest 100 unread.</div>' : ''}
    <div class="nv-src">Clicking opens the mail in Apple Mail. Nothing is marked read from here.</div>`
}

// ---------- render ----------

function render() {
  const now = Date.now()
  const counts = { tasks: data.tasks?.tasks.length, mail: data.mail?.unreadTotal }
  tabsEl.innerHTML = TABS.map(([id, label]) => `<button class="nv-tab" role="tab" data-nv-tab="${id}" aria-selected="${tab === id}">${esc(label)}${counts[id] != null ? `<span class="nv-count">${counts[id]}</span>` : ''}</button>`).join('')
  const cal = tab === 'calendar'
  calHeader.hidden = !cal
  calMain.hidden = !cal
  view.hidden = cal
  if (cal) return
  const html = tab === 'tasks' ? tasksView(now) : tab === 'classes' ? classesView() : tab === 'mail' ? mailView() : dashboard(now)
  draw(view, html)
}

// ---------- events (nv- data attributes only; the Calendar's own handler ignores them) ----------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-nv-tab],[data-nv-task],[data-nv-toggle],[data-nv-file],[data-nv-reveal],[data-nv-mail],[data-nv-filter],[data-nv-refresh]')
  if (!el) return
  const ds = el.dataset
  if (ds.nvTab) return setTab(ds.nvTab)
  if (ds.nvRefresh) return void loadAll()
  if (ds.nvTask) {
    openTask = ds.nvTask
    setTab('tasks')
    const t = data.tasks?.tasks.find((x) => x.id === openTask)
    if (t && t.link.kind !== 'none') void loadPack(t)
    requestAnimationFrame(() => $(`nv-task-${openTask}`)?.scrollIntoView({ block: 'start' }))
    return
  }
  if (ds.nvToggle) {
    openTask = openTask === ds.nvToggle ? null : ds.nvToggle
    const t = data.tasks?.tasks.find((x) => x.id === openTask)
    if (t) void loadPack(t)
    return render()
  }
  if (ds.nvFile) return void req('file.open', { path: ds.nvFile })
  if (ds.nvReveal) return void req('file.open', { path: ds.nvReveal, reveal: true })
  if (ds.nvMail !== undefined) return void req('mail.open', { messageId: ds.nvMail })
  if (ds.nvFilter) {
    mailFilter = ds.nvFilter
    return render()
  }
})

document.addEventListener('change', (e) => {
  const id = e.target?.dataset?.nvOverride
  if (!id) return
  const stage = e.target.value || null
  req('task.override', { id, stage }).then(
    (snap) => ((data.tasks = snap), render()),
    (err) => ((data.errors.tasks = err?.message || String(err)), render())
  )
})

async function loadPack(t) {
  if (packs.has(t.link.path)) return
  packs.set(t.link.path, 'loading')
  render()
  try {
    packs.set(t.link.path, await req('pack.get', { path: t.link.path }))
  } catch (err) {
    packs.set(t.link.path, { path: t.link.path, title: '', sections: [], drafts: [], note: err?.message || String(err) })
  }
  render()
}

// The Calendar's own refresh posts 'agenda.changed'; keep the dashboard's schedule in step.
orca.plugin?.on?.('agenda.changed', () => req('agenda.get').then((s) => ((data.agenda = s), render()), () => {}))
orca.on?.('theme', () => render())
function tick() {
  if (tab !== 'calendar' && !document.querySelector('select:focus')) render()
  setTimeout(tick, 60_000 - (Date.now() % 60_000) + 80)
}
setTimeout(tick, 60_000 - (Date.now() % 60_000) + 80)
render()
loadAll()
