// Pure rules: step progress and spaced repetition (spec 8.1, 8.2) and the flashcard keys (spec 7.2). No React
// and no storage here. Dates are local calendar days written `YYYY-MM-DD`.

export type CardState = { box: 0 } | { box: 1 | 2 | 3; due: string }
export type Progress = {
  version: 1
  updatedAt: string
  checks: Record<string, true>
  read: Record<string, true>
  cards: Record<string, CardState>
  lastVisited?: string
}
export type StepKind = 'overview' | 'reading' | 'build' | 'quiz'
export type StepRef = { kind: StepKind; id: string; path: string; title: string; group?: string }
/** `studyIds` lists only the non-optional study items. */
export type WeekIndex = {
  n: number
  title: string
  duration?: string
  steps: StepRef[]
  studyIds: string[]
  taskIds: string[]
  cardIds: string[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The local calendar day of `now`. */
export function today(now = new Date()): string {
  return ymd(now)
}

/** `day` plus `days` calendar days. The Date constructor rolls the day over, so a DST change can't shift it. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + days))
}

/** The due date of a card in review (box 1-3). Undefined for a card never rated or known (box 0). */
const dueOf = (card: CardState | undefined) => (card && card.box ? card.due : undefined)

/** In review (box 1-3) with a due date of `day` or earlier. */
export function isDue(card: CardState | undefined, day: string): boolean {
  const due = dueOf(card)
  return due !== undefined && due <= day
}

/** The card after a rating on `day` (spec 8.2). */
export function rate(card: CardState | undefined, knew: boolean, day: string): CardState {
  if (!knew) return { box: 1, due: addDays(day, 1) }
  if (!card) return { box: 0 }
  if (card.box === 0 || !isDue(card, day)) return card // already known, or practice before the due date
  if (card.box === 3) return { box: 0 }
  return card.box === 1 ? { box: 2, due: addDays(day, 3) } : { box: 3, due: addDays(day, 7) }
}

const doneIn = (ids: string[], done: Record<string, unknown>) => ids.filter(id => done[id]).length
/** The share of `ids` that are in `done`. An empty list counts as 1. */
const share = (ids: string[], done: Record<string, unknown>) => (ids.length ? doneIn(ids, done) / ids.length : 1)
/** 0 for an empty list, so no week or plan ever gives NaN. */
const mean = (xs: number[]) => (xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0)

/** How done a step is, from 0 to 1 (spec 8.1). */
export function stepFraction(week: WeekIndex, step: StepRef, p: Progress): number {
  switch (step.kind) {
    case 'overview':
      return share(week.studyIds, p.checks)
    case 'reading':
      return p.read[step.id] ? 1 : 0
    case 'build':
      return share(week.taskIds, p.checks)
    case 'quiz':
      return share(week.cardIds, p.cards) // a card counts once it has been rated, in any box
  }
}

/** `fraction` is the average over the steps, `finished` counts those at 1, and the tasks are the Build & Test items. */
export function weekStats(
  week: WeekIndex,
  p: Progress,
): { fraction: number; finished: number; total: number; tasksDone: number; tasksTotal: number } {
  const fractions = week.steps.map(step => stepFraction(week, step, p))
  return {
    fraction: mean(fractions),
    finished: fractions.filter(f => f === 1).length,
    total: fractions.length,
    tasksDone: doneIn(week.taskIds, p.checks),
    tasksTotal: week.taskIds.length,
  }
}

/** The mean of the week fractions: each week counts the same. */
export function overallFraction(weeks: WeekIndex[], p: Progress): number {
  return mean(weeks.map(w => weekStats(w, p).fraction))
}

/** The first week with a Build & Test item not ticked yet. */
export function currentWeek(weeks: WeekIndex[], p: Progress): WeekIndex | undefined {
  return weeks.find(w => w.taskIds.some(id => !p.checks[id]))
}

/** The cards due on `day`, earliest due date first. Ties keep the input order (Array#sort is stable). */
export function dueCardIds(cardIds: string[], p: Progress, day: string): string[] {
  const due = (id: string) => dueOf(p.cards[id]) ?? ''
  return cardIds
    .filter(id => isDue(p.cards[id], day))
    .sort((a, b) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0))
}

/** The earliest due date among the cards in review, whether or not it has come yet. */
export function nextDue(cardIds: string[], p: Progress): string | undefined {
  return cardIds.map(id => dueOf(p.cards[id])).filter(due => due !== undefined).sort()[0]
}

const FORM_FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * What a keydown does to the flashcard on screen. Space flips; 1 (knew it) and 2 (didn't know) rate, but only
 * after the flip. Nothing happens with Ctrl, Meta or Alt held, or while the focus is in an input, textarea,
 * select or contenteditable element.
 */
export function cardKeyAction(
  e: {
    key: string
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    target: { tagName?: string; isContentEditable?: boolean } | null
  },
  flipped: boolean,
): 'flip' | 'knew' | 'didnt' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  const tag = e.target?.tagName?.toUpperCase() ?? ''
  if (e.target?.isContentEditable || FORM_FIELDS.has(tag)) return null
  if (e.key === ' ') return tag === 'BUTTON' ? null : 'flip' // Space on a focused button clicks it: the browser's job
  if (e.key === '1' && flipped) return 'knew'
  if (e.key === '2' && flipped) return 'didnt'
  return null
}
