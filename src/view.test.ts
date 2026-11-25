// Pure helpers of the Nova panel page.
import { assert, test } from 'orca/testing'
// @ts-ignore: plain ESM
import { classGlance, countdown, markdown, timeTone } from '../nova/view.mjs'

test('countdowns are short and never wrap-prone', () => {
  assert.equal(countdown(2 * 86400e3 + 8 * 3600e3), '2d 8h')
  assert.equal(countdown(5 * 3600e3), '5h')
  assert.equal(countdown(40 * 60e3), '40m')
  assert.equal(countdown(-1), 'now')
})

test('time-left colours', () => {
  assert.equal(timeTone(null, 0), 'none')
  assert.equal(timeTone(10 * 3600e3, 0), 'red')
  assert.equal(timeTone(3 * 86400e3, 0), 'amber')
  assert.equal(timeTone(6 * 86400e3, 0), 'green')
})

test('next class and classes left', () => {
  const classes = [{ start: '09:30', end: '11:00', title: 'Course A', room: 'Room 1.01' }, { start: '11:00', end: '14:00', title: 'Course B', room: 'Room 2.02' }]
  assert.deepEqual(classGlance(classes, '15:12'), { next: null, now: false, left: 0 })
  const g = classGlance(classes, '10:00')
  assert.equal(g.left, 2)
  assert.equal(g.next.title, 'Course B')
})

test('pack markdown is escaped and structured', () => {
  const html = markdown('**Due** 19 Jan\n- one <b>\n- two\n1. a\n> quote')
  assert.ok(html.includes('<strong>Due</strong>'))
  assert.ok(html.includes('<ul><li>one &lt;b&gt;</li><li>two</li></ul>'))
  assert.ok(html.includes('<ol><li>a</li></ol>'))
  assert.ok(html.includes('<blockquote>quote</blockquote>'))
})
