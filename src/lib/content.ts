// Server only: joins Velite's output into weeks, steps and cards for the pages. Client components may
// `import type` from here, never values: a value import would ship all the content to the browser.
import { notes, plan } from '#site/content'
import type { StepRef, WeekIndex } from './progress'

/** For the pages that show the plan's own text (its title, intro and capstone checklist), which no week holds. */
export { plan }

export type Week = (typeof plan)['weeks'][number]
export type Notes = (typeof notes)[number]
export type Card = { id: string; label: string; questionHtml: string; answerHtml?: string }
export type TocItem = { id: string; title: string; level: 2 | 3 }

/** In ascending week number: `currentWeek()` and the previous/next week links rely on it. */
export const weeks: Week[] = [...plan.weeks].sort((a, b) => a.n - b.n)

export const getWeek = (n: number): Week | undefined => weeks.find(w => w.n === n)
export const getNotes = (slug: string): Notes | undefined => notes.find(doc => doc.slug === slug)

/** "Week 1: Async Python" becomes "Async Python". */
export const shortTitle = (doc: Notes): string => doc.title.replace(/^Week \d+:\s*/, '')

/** The notes files the week links to, each once, in link order. */
export function linkedNotes(week: Week): Notes[] {
  const slugs = new Set(week.notesRefs.flatMap(ref => (ref.slug ? [ref.slug] : [])))
  return [...slugs].flatMap(slug => getNotes(slug) ?? [])
}

/** The week's reading steps, each with its notes file and section: every link's sections in link order, a repeat kept once. */
function readingOf(week: Week) {
  const seen = new Set<string>()
  return week.notesRefs.flatMap(ref => {
    const doc = ref.slug ? getNotes(ref.slug) : undefined
    if (!doc) return []
    const sections = ref.sections === 'all' ? doc.sections : ref.sections.flatMap(n => doc.sections.find(s => s.n === n) ?? [])
    return sections.flatMap(section => {
      const id = `${doc.slug}-${section.n}`
      if (seen.has(id)) return []
      seen.add(id)
      return [{ id, doc, section }]
    })
  })
}

/** Overview, the reading steps, Build & Test, then Quiz when the week owns any cards. */
export function stepsOf(week: Week): StepRef[] {
  const base = `/week/${week.n}`
  const reading = readingOf(week)
  const grouped = new Set(reading.map(r => r.doc.slug)).size > 1
  const steps: StepRef[] = [
    { kind: 'overview', id: 'overview', path: base, title: 'Overview' },
    ...reading.map(({ id, doc, section }): StepRef => ({
      kind: 'reading',
      id,
      path: `${base}/${id}`,
      title: section.title,
      group: grouped ? shortTitle(doc) : undefined,
    })),
    { kind: 'build', id: 'build', path: `${base}/build`, title: 'Build & Test' },
  ]
  if (quizCards(week).length) steps.push({ kind: 'quiz', id: 'quiz', path: `${base}/quiz`, title: 'Quiz' })
  return steps
}

/** The notes file and section behind the reading step `stepId` of this week; undefined when it isn't one. */
export function readingSection(week: Week, stepId: string): { notes: Notes; section: Notes['sections'][number] } | undefined {
  const step = readingOf(week).find(r => r.id === stepId)
  return step && { notes: step.doc, section: step.section }
}

/** A notes file's quiz belongs to the highest week number that links it. */
const ownerOf = (doc: Notes) => Math.max(...weeks.filter(w => w.notesRefs.some(ref => ref.slug === doc.slug)).map(w => w.n))

/** The linked notes files whose quiz belongs to this week. */
export const quizNotes = (week: Week): Notes[] => linkedNotes(week).filter(doc => ownerOf(doc) === week.n)

export function quizCards(week: Week): Card[] {
  return quizNotes(week).flatMap(doc =>
    doc.quiz.cards.map(card => ({
      id: `${doc.slug}-q${card.n}`,
      label: `Week ${week.n} · ${shortTitle(doc)} · Q${card.n}`,
      questionHtml: card.question,
      answerHtml: card.answer,
    })),
  )
}

/** Every card, in week order. */
export const allCards = (): Card[] => weeks.flatMap(quizCards)

/**
 * "From the notes" on the Build & Test step: each linked notes file's Apply section, or only this week's
 * `### Week N` part when the section is split into parts; then this week's part of any notes file the week
 * doesn't link (the testing notes' Week 6 part lands on Week 6).
 */
export function applyFor(week: Week): { slug: string; title: string; html: string }[] {
  const linked = linkedNotes(week)
  const part = (doc: Notes) => doc.applyParts.find(p => p.week === week.n)?.body
  return [...linked, ...notes.filter(doc => !linked.includes(doc))].flatMap(doc => {
    const html = linked.includes(doc) && !doc.applyParts.length ? doc.apply : part(doc)
    return html ? [{ slug: doc.slug, title: shortTitle(doc), html }] : []
  })
}

/** Where a Study notes link points: its notes' first reading step this week, else Build & Test. A link that matched no notes file keeps its URL. */
export function refTarget(week: Week, ref: Week['notesRefs'][number]): { href: string; external: boolean } {
  if (!ref.slug) return { href: ref.url, external: true }
  const first = readingOf(week).find(r => r.doc.slug === ref.slug)
  return { href: `/week/${week.n}/${first?.id ?? 'build'}`, external: false }
}

export function weekIndex(week: Week): WeekIndex {
  return {
    n: week.n,
    title: week.title,
    duration: week.duration,
    steps: stepsOf(week),
    studyIds: week.study.filter(item => !item.optional).map(item => item.id),
    taskIds: week.checklists.flatMap(list => list.items.map(task => task.id)),
    cardIds: quizCards(week).map(card => card.id),
  }
}

export const weekIndexes = (): WeekIndex[] => weeks.map(weekIndex)

/** Where a week's last step leads: the next week's Overview, or the Capstone after the last week. */
export function afterWeek(week: Week): { path: string; title: string } {
  const next = weeks[weeks.indexOf(week) + 1]
  return next ? { path: `/week/${next.n}`, title: `Week ${next.n} · ${next.title}` } : { path: '/capstone', title: 'Capstone' }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** The text of an HTML fragment: tags removed, character references decoded in one pass (so `&amp;lt;` stays `&lt;`). */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#([xX][\da-fA-F]+|\d+)|(amp|lt|gt|quot|apos|nbsp));/g, (ref, num?: string, name?: string) => {
      if (name) return NAMED[name]
      const code = /^x/i.test(num!) ? parseInt(num!.slice(1), 16) : parseInt(num!, 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : ref
    })
    .trim()

/** The `<h2>` and `<h3>` headings that have an id, for "On this page". */
export function tocOf(html: string): TocItem[] {
  return [...html.matchAll(/<h([23])\b[^>]*?\sid="([^"]*)"[^>]*>([\s\S]*?)<\/h\1>/g)].map(m => ({
    id: m[2],
    title: textOf(m[3]),
    level: m[1] === '2' ? 2 : 3,
  }))
}

/** One paragraph's HTML without its `<p>…</p>`, for text inside a list item. Anything else comes back as it is. */
export function inlineHtml(html: string): string {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html.trim())
  return m && !m[1].includes('</p>') ? m[1] : html
}
