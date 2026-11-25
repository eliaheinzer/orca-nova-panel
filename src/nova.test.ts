// Parser tests for tasks, packs, mail folders and the status bar: no real files are read here.
import { assert, test } from 'orca/testing'
import { evaluateRows, findNovaOneDrive, folderOf, pickNovaAccount, lisbonMs, parsePack, parseRows, parseTasks, stageFromEvidence, statusBarText, taskId } from './nova'

const NOW = lisbonMs(2030, 1, 14, 15, 0)
const TASKS = `# Review queue (Nova)

Updated 14 Jan 2030 09:04 · 1 new since last run. Edit nothing here except ✅.

| Status | Due | Course | Task | Link |
|---|---|---|---|---|
| 🔥 urgent · pack ready | Today Mon 14 Jan 14:00 (team), Sat 19 Jan 23:59 (Moodle) | Course A | Group report | [pack](/home/student/OD/a/_PREP 2030-01-14 GRM.md) |
| ⚠️ overdue on Moodle · prepared | Fri 11 Jan 23:59 | Course B | Essay draft | [pack](/home/student/OD/b/_PREP.md) |
| 🆕 prepared | no date set | Course C | Interview questions | [pack](/home/student/OD/c/_PREP c.md) |
| ⏳ not prepared yet | Wed 16 Jan 23:59 | Course D | Reflections 1–3 | Moodle |
| ✅ done | Thu 17 Jan 23:59 | Course E | Slides | Moodle |
| ⏳ not prepared yet | Mon 21 Jan 23:59 | Course B | Essay | Moodle |
`

test('open rows only, soonest first, no overdue or done', () => {
  const { tasks, hidden, updated } = parseTasks(TASKS, NOW)
  assert.ok(updated.startsWith('Updated 14 Jan 2030'))
  // Course A's team date (14 Jan 14:00) passed but its Moodle date (19 Jan) is ahead → kept, due 19 Jan.
  // Course B's essay draft is overdue and Course E is ✅ done → hidden.
  assert.equal(hidden, 2)
  assert.deepEqual(tasks.map((t) => t.course), ['Course D', 'Course A', 'Course B', 'Course C'])
  assert.equal(tasks[1].dueAt, lisbonMs(2030, 1, 19, 23, 59))
  assert.equal(tasks[0].link.kind, 'none')
  assert.equal(tasks[3].link.path, '/home/student/OD/c/_PREP c.md')
  assert.equal(tasks[3].dueAt, null)
  assert.equal(tasks[1].id, taskId('Course A', 'Group report'))
})

test('a 🔥 row due later stays and drives the status bar', () => {
  const { tasks } = parseTasks(TASKS.replace('Today Mon 14 Jan 14:00', 'Tue 15 Jan 14:00'), NOW)
  const bar = statusBarText(tasks, NOW)
  assert.equal(bar.text, 'Nova · 1 urgent · next in 23 h')
  assert.equal(bar.tone, 'danger')
})

test('status comes from the folder, with the reason', () => {
  const pack = { rowDone: false, link: { kind: 'pack' as const, path: '/OD/x/_PREP 2030-01-14 X.md', label: 'pack' } }
  const t = lisbonMs(2030, 1, 14, 12, 0)
  const f = (name: string, mtime = t) => ({ name, mtime })
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md')]).stage, 'prepared')
  const prog = stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('Deck v3.pptx', t + 3600e3), f('old.pdf', t - 3 * 86400e3)])
  assert.equal(prog.stage, 'in-progress')
  assert.equal(prog.lastEdit?.file, 'Deck v3.pptx')
  assert.match(prog.why, /1 file edited since the pack/)
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('_DRAFT 2030-01-14 outline.md')]).stage, 'in-progress')
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('_READY 2030-01-15 deck.pdf')]).stage, 'ready')
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('Report - SUBMITTED 13 Jan.pdf')]).stage, 'done')
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('report_FINAL.docx')]).stage, 'done')
  assert.equal(stageFromEvidence(pack, [f('_PREP 2030-01-14 X.md'), f('~$Deck.pptx', t + 3600e3), f('.DS_Store', t + 3600e3)]).stage, 'prepared')
  assert.equal(stageFromEvidence({ rowDone: false, link: { kind: 'none', path: '', label: 'Moodle' } }, null).stage, 'not-started')
  assert.equal(stageFromEvidence({ rowDone: true, link: { kind: 'none', path: '', label: 'Moodle' } }, null).stage, 'done')
  const named = stageFromEvidence({ rowDone: false, link: { kind: 'none', path: '', label: 'Moodle' } }, [f('Journal entry 1.docx', t)], 'Reflection Journal')
  assert.equal(named.stage, 'in-progress')
  assert.match(named.why, /Reflection Journal/)
})

test('an override wins until the TASKS.md row changes', async () => {
  const mem = new Map<string, unknown>()
  const store = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: unknown) => void mem.set(k, v), delete: async (k: string) => void mem.delete(k) }
  const { rows } = parseRows(TASKS, NOW)
  const rowD = rows.find((r) => r.course === 'Course D')!
  mem.set('ov.' + rowD.id, { stage: 'ready', row: rowD.row })
  let [item] = await evaluateRows([rowD], store)
  assert.equal(item.stage, 'ready')
  assert.equal(item.stageFrom, 'override')
  ;[item] = await evaluateRows([{ ...rowD, row: rowD.row + ' changed' }], store)
  assert.equal(item.stage, 'not-started')
  assert.equal(mem.has('ov.' + rowD.id), false)
})

test('pack sections come out in the panel order', () => {
  const md = `# _PREP 14 Jan 2030: Group report

## What & when
Report due 19 Jan.

## What the professor wants
Rubric: 40% analysis.

## Status (as of 14 Jan 09:03)
A teammate did slides 1-4.

## Plan
1. Forecast.

## Open questions
- Which market?

## Next step
Comment on slide 5.
`
  const { title, sections } = parsePack(md)
  assert.equal(title, '14 Jan 2030: Group report')
  assert.deepEqual(sections.map((s) => s.title), [
    'Next step',
    'What & when',
    'What the professor wants (requirements & rubric)',
    'Status (as of 14 Jan 09:03)',
    'Plan',
    'Open questions'
  ])
})

test('mail folders: inbox and own folders, never deleted/sent/drafts/junk/system folders', () => {
  const acct = 'ews://00000000-1111-2222-3333-444444444444/'
  assert.equal(folderOf(acct + 'Posteingang', acct), 'Inbox')
  assert.equal(folderOf(acct + 'Inbox', acct), 'Inbox')
  assert.equal(folderOf(acct + '5%20Events%20&%20Clubs', acct), '5 Events & Clubs')
  assert.equal(folderOf(acct + 'Inbox/Courses', acct), 'Inbox/Courses')
  for (const skip of ['Gelo%CC%88schte%20Elemente', 'Deleted%20Items', 'Gesendete%20Elemente', 'Sent%20Items', 'Entwu%CC%88rfe', 'Drafts', 'Junk-E-Mail', 'Junk%20Email', 'Postausgang', 'Archiv', 'Verlauf%20der%20Unterhaltung', 'Conversation%20History', 'Notizen', 'RSS-Feeds', 'Sync%20Issues/Conflicts', 'Aufgaben', 'Journal']) {
    assert.equal(folderOf(acct + skip, acct), null, skip)
  }
  assert.equal(folderOf('imap://other/INBOX', acct), null)
})

test('the Nova account is the one with the most @novasbe.pt mail', () => {
  const by = new Map([
    ['imap://aaaa/', new Map([['12345@novasbe.pt', 3]])],
    ['ews://bbbb/', new Map([['12345@novasbe.pt', 40], ['all-students@novasbe.pt', 12]])]
  ])
  assert.deepEqual(pickNovaAccount(by), { account: 'ews://bbbb/', address: '12345@novasbe.pt' })
  assert.equal(pickNovaAccount(new Map()), null)
})

test('the OneDrive folder is the one named with Nova', () => {
  assert.equal(findNovaOneDrive(['OneDrive-Personal', 'OneDrive-Nova School', 'GoogleDrive'], '/cs'), '/cs/OneDrive-Nova School')
  assert.equal(findNovaOneDrive(['OneDrive-NovaSBE'], '/cs'), '/cs/OneDrive-NovaSBE')
  assert.equal(findNovaOneDrive(['OneDrive-Personal'], '/cs'), '/cs/OneDrive-NovaSBE')
  assert.equal(findNovaOneDrive(['OneDrive-Nova A', 'OneDrive-Nova B'], '/cs', (d) => (d.endsWith('B') ? 2 : 1)), '/cs/OneDrive-Nova B')
})
