// Parser tests: no real files are read here.
import { assert, test } from 'orca/testing'
import { parseDeadlines, parseIcs } from './worker'

const MD = `# Nova deadlines

Updated 14 Jan 2030 09:04 by hand. More text.

## Due in the next 21 days

| Date | Day | Time | Course | What | Source |
|---|---|---|---|---|---|
| 11 Jan | Fri | 23:59 | Course B | ⚠️ OVERDUE: Essay draft. Pack: \`3 Assignments/Essay\` | Moodle |
| 9 Jan | Wed | 23:59 | Old | Done thing | Moodle |
| 16 Jan | Wed | 23:59 | Course D | Reflections 1–3 | Moodle |
| 14 Jan | Mon | 14:00 | Course A | ⚠️ 🆕 Team deadline | WhatsApp |
| 28 Jan | Mon | 23:59 | Later | Outside the 7 days | Moodle |

## Exams
| 30 Jan | Wed | 09:00 | X | Exam | Portal |
`

test('reads next-7-day deadlines only, never overdue ones', () => {
  const { items, updated } = parseDeadlines(MD, '2030-01-14')
  assert.equal(updated, 'Updated 14 Jan 2030 09:04 by hand')
  assert.deepEqual(items.map((d) => d.course), ['Course D', 'Course A'])
  assert.equal(items.some((d) => d.overdue), false)
  assert.equal(items[0].what.includes('`'), false)
  assert.equal(items[1].urgent && items[1].isNew, true)
})

test('reads classes from an .ics export', () => {
  const ics = 'BEGIN:VEVENT\nDTSTART;TZID=Europe/Lisbon:20300114T110000\nDTEND;TZID=Europe/Lisbon:20300114T123000\nSUMMARY:Course A · Room 1.01\nLOCATION:Room 1.01\\, Campus\nEND:VEVENT\n'
  assert.deepEqual(parseIcs(ics), [{ date: '2030-01-14', start: '11:00', end: '12:30', title: 'Course A', room: 'Room 1.01' }])
})
