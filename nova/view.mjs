// Pure helpers for the Nova panel (no DOM, no Orca): tested in src/view.test.ts.

export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function short(text, n = 160) {
  const s = String(text ?? '')
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s
}

/** "2d 8h", "5h", "40m", "now": short enough never to wrap. */
export function countdown(ms) {
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ${mins % 60 ? (mins % 60) + 'm' : ''}`.trim()
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** red under 36 h, amber under 4 days, green after; grey without a date. */
export function timeTone(dueAt, now) {
  if (dueAt == null) return 'none'
  const left = dueAt - now
  if (left < 36 * 3600e3) return 'red'
  if (left < 4 * 86400e3) return 'amber'
  return 'green'
}

export const STAGE_LABEL = { 'not-prepared': 'Not prepared yet', prepared: 'Pack prepared', 'head-start': 'Head start ready', done: 'Done' }

/** "HH:MM" in Lisbon. */
export function lisbonHHMM(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
}

/** The class now or next today, and how many are left (ending after now). */
export function classGlance(classes, hhmm) {
  const left = classes.filter((c) => (c.end || c.start) > hhmm)
  const next = left.find((c) => c.start > hhmm) ?? left[0] ?? null
  return { next, now: next ? next.start <= hhmm : false, left: left.length }
}

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="nv-link">$1</span>')
}

/** A small, safe Markdown subset for task packs: headings, lists, quotes, paragraphs, inline code/bold. */
export function markdown(md) {
  const out = []
  let list = null
  const close = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let m
    if (!line.trim()) {
      close()
      continue
    }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      close()
      out.push(`<h4>${inline(m[1])}</h4>`)
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') {
        close()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') {
        close()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      close()
      out.push(`<blockquote>${inline(m[1])}</blockquote>`)
    } else if (/^\|/.test(line)) {
      close()
      if (!/^\|\s*-/.test(line)) out.push(`<p class="nv-row">${inline(line.split('|').slice(1, -1).map((c) => c.trim()).join(' · '))}</p>`)
    } else {
      close()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  close()
  return out.join('')
}
