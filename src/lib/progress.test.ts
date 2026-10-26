process.env.TZ = 'Europe/Berlin' // EU DST ends on Sunday 2026-10-25
import { describe, expect, it } from 'vitest'
import { addDays, cardKeyAction, currentWeek, dueCardIds, isDue, nextDue, overallFraction, percent, rate, resumeLink, today, weekStats, type Progress, type WeekIndex } from './progress'

const P = (over: Partial<Progress> = {}): Progress => ({ version: 1, updatedAt: '', checks: {}, read: {}, cards: {}, ...over })
const D = '2026-10-25'

describe('rate (spec 8.2)', () => {
  it.each([
    ['didnt, anything', { box: 0 } as const, false, { box: 1, due: '2026-10-26' }],
    ['didnt, box 3 due', { box: 3, due: D } as const, false, { box: 1, due: '2026-10-26' }],
    ['knew, never rated', undefined, true, { box: 0 }],
    ['knew, box 0', { box: 0 } as const, true, { box: 0 }],
    ['knew, not due yet', { box: 1, due: '2026-10-26' } as const, true, { box: 1, due: '2026-10-26' }],
    ['knew, box 2 not due yet', { box: 2, due: '2026-10-27' } as const, true, { box: 2, due: '2026-10-27' }],
    ['knew, box 3 not due yet', { box: 3, due: '2026-11-01' } as const, true, { box: 3, due: '2026-11-01' }],
    ['knew, box 1 due', { box: 1, due: D } as const, true, { box: 2, due: '2026-10-28' }],
    ['knew, box 2 overdue', { box: 2, due: '2026-10-01' } as const, true, { box: 3, due: '2026-11-01' }],
    ['knew, box 3 due', { box: 3, due: D } as const, true, { box: 0 }],
  ])('%s', (_, card, knew, expected) => expect(rate(card, knew, D)).toEqual(expected))
})

describe('local dates', () => {
  it('cross the DST change without drifting', () => {
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(addDays('2026-10-25', 7)).toBe('2026-11-01')
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
  })
  it('use the local calendar day', () => expect(today(new Date(2026, 9, 25, 0, 30))).toBe(D))
  it('treat due today and overdue as due', () => {
    expect(isDue({ box: 1, due: D }, D)).toBe(true)
    expect(isDue({ box: 2, due: '2026-10-01' }, D)).toBe(true)
    expect(isDue({ box: 1, due: '2026-10-26' }, D)).toBe(false)
    expect(isDue({ box: 0 }, D)).toBe(false)
    expect(isDue(undefined, D)).toBe(false)
  })
})

const week = (n: number, taskIds: string[]): WeekIndex => ({
  n, title: `W${n}`, studyIds: ['s1', 's2'], taskIds, cardIds: ['c1', 'c2'],
  steps: [
    { kind: 'overview', id: 'overview', path: `/week/${n}`, title: 'Overview' },
    { kind: 'reading', id: 'x-1', path: `/week/${n}/x-1`, title: 'One' },
    { kind: 'reading', id: 'x-2', path: `/week/${n}/x-2`, title: 'Two' },
    { kind: 'build', id: 'build', path: `/week/${n}/build`, title: 'Build & Test' },
    { kind: 'quiz', id: 'quiz', path: `/week/${n}/quiz`, title: 'Quiz' },
  ],
})

describe('progress (spec 8.1)', () => {
  const p = P({ checks: { s1: true, t1: true, t2: true }, read: { 'x-1': true }, cards: { c1: { box: 0 } } })
  it('averages step fractions and counts finished steps', () => {
    expect(weekStats(week(0, ['t1', 't2', 't3', 't4']), p)).toEqual({ fraction: 0.5, finished: 1, total: 5, tasksDone: 2, tasksTotal: 4 })
  })
  it('picks the first week with an unticked task, and averages weeks', () => {
    const done = week(0, ['t1', 't2']), open = week(1, ['t3'])
    expect(currentWeek([done, open], p)?.n).toBe(1)
    expect(currentWeek([done], p)).toBeUndefined()
    expect(overallFraction([], p)).toBe(0)
  })
  it('sorts due cards by date and finds the next one', () => {
    const q = P({ cards: { a: { box: 1, due: D }, b: { box: 2, due: '2026-10-20' }, c: { box: 1, due: '2026-10-30' }, d: { box: 0 } } })
    expect(dueCardIds(['a', 'b', 'c', 'd'], q, D)).toEqual(['b', 'a'])
    expect(nextDue(['c', 'd'], q)).toBe('2026-10-30')
  })
})

describe('resumeLink (the dashboard Continue button)', () => {
  const weeks = [week(0, ['t1']), week(1, ['t2'])]
  const go = (current: WeekIndex, lastVisited?: string) => resumeLink(weeks, current, P({ lastVisited }))
  it('names only the step for a step in the current week', () => {
    expect(go(weeks[1], '/week/1/x-2')).toEqual({ href: '/week/1/x-2', label: 'Continue: Two' })
  })
  it('names the week too for a step in another week', () => {
    expect(go(weeks[1], '/week/0/build')).toEqual({ href: '/week/0/build', label: 'Continue: Week 0 · Build & Test' })
  })
  it('starts at the current week Overview when nothing was visited', () => {
    expect(go(weeks[1])).toEqual({ href: '/week/1', label: 'Start: Week 1 · W1' })
    expect(go(weeks[0])).toEqual({ href: '/week/0', label: 'Start: Week 0 · W0' }) // the first visit: Week 0 is the current week
  })
  it('does the same when the last page is no longer a step', () => {
    expect(go(weeks[1], '/week/1/gone-3')).toEqual({ href: '/week/1', label: 'Start: Week 1 · W1' })
    expect(go(weeks[1], '/week/7/build')).toEqual({ href: '/week/1', label: 'Start: Week 1 · W1' })
  })
})

describe('percent', () => {
  it.each([[0, 0], [0.5, 50], [1 / 3, 33], [2 / 3, 67], [1, 100]])('%s is %s', (fraction, out) => expect(percent(fraction)).toBe(out))
  it('reads 100 only when the fraction is exactly 1', () => {
    expect(percent(0.995)).toBe(99) // rounds to 100, but something is left
    expect(percent(119 / 120)).toBe(99)
    expect(percent(1 - Number.EPSILON)).toBe(99)
  })
})

describe('cardKeyAction', () => {
  const t = (tagName?: string, isContentEditable?: boolean) => ({ tagName, isContentEditable })
  it.each([
    [' ', t('DIV'), false, 'flip'], [' ', t('DIV'), true, 'flip'],
    ['1', t('DIV'), false, null], ['1', t('DIV'), true, 'knew'], ['2', t('BODY'), true, 'didnt'],
    ['1', t('INPUT'), true, null], [' ', t('TEXTAREA'), false, null], [' ', t('SELECT'), false, null],
    [' ', t('DIV', true), false, null], [' ', t('BUTTON'), false, null], ['2', t('BUTTON'), true, 'didnt'],
  ])('%j on %j (flipped %s) → %s', (key, target, flipped, out) => expect(cardKeyAction({ key, target }, flipped)).toBe(out))
  it('ignores modified keys', () => expect(cardKeyAction({ key: '1', ctrlKey: true, target: t('DIV') }, true)).toBeNull())
})

describe('edge rules (stated in the interfaces, not reached by the cases above)', () => {
  const build = { kind: 'build', id: 'build', path: '/', title: 'Build & Test' } as const
  const read = { kind: 'reading', id: 'r-1', path: '/', title: 'One' } as const
  const mini = (n: number, taskIds: string[], steps: WeekIndex['steps']): WeekIndex => ({ n, title: `W${n}`, studyIds: [], taskIds, cardIds: [], steps })

  it('counts an empty list as done', () => {
    // no study items, tasks or cards: overview, build and quiz are 1 with nothing ticked; the two readings are 0
    expect(weekStats({ ...week(0, []), studyIds: [], cardIds: [] }, P())).toMatchObject({ fraction: 0.6, finished: 3, tasksDone: 0, tasksTotal: 0 })
  })
  it('averages the weeks, not the steps', () => {
    const weeks = [mini(0, ['a'], [build]), mini(1, ['b'], [build, read])] // week fractions 1 and (0 + 1) / 2
    expect(overallFraction(weeks, P({ checks: { a: true }, read: { 'r-1': true } }))).toBe(0.75)
  })
  it('keeps the input order for cards due on the same day', () => {
    const q = P({ cards: { a: { box: 1, due: D }, b: { box: 2, due: D }, c: { box: 3, due: D } } })
    expect(dueCardIds(['c', 'a', 'b'], q, D)).toEqual(['c', 'a', 'b'])
  })
})
