import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Fragment } from 'react'
import { DocLayout } from '../../../../components/chrome'
import { Flashcards } from '../../../../components/Flashcards'
import { WeekSidebar } from '../../../../components/nav'
import { Checklist, StepFooter, TrackVisit } from '../../../../components/progress-widgets'
import {
  afterWeek,
  applyFor,
  getWeek,
  inlineHtml,
  quizCards,
  quizNotes,
  readingSection,
  shortTitle,
  stepsOf,
  tocOf,
  weekIndex,
  weeks,
  type TocItem,
} from '../../../../lib/content'

export const dynamicParams = false
export const generateStaticParams = () =>
  weeks.flatMap(w => stepsOf(w).flatMap(s => (s.kind === 'overview' ? [] : [{ week: String(w.n), step: s.id }])))

type Props = { params: Promise<{ week: string; step: string }> }

/** The week, its steps, and where this step sits in them. The Overview has its own page, so it isn't a step here. */
async function stepOf(params: Props['params']) {
  const { week: n, step: id } = await params
  const week = getWeek(Number(n))
  const steps = week ? stepsOf(week) : []
  const at = steps.findIndex(s => s.id === id && s.kind !== 'overview')
  if (!week || at < 0) notFound()
  return { week, steps, at, step: steps[at], reading: readingSection(week, id) }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { week, step, reading } = await stepOf(params)
  const heading = reading ? `${reading.section.n}. ${reading.section.title}` : step.title
  return { title: `${heading} · Week ${week.n}` }
}

export default async function StepPage({ params }: Props) {
  const { week, steps, at, step, reading } = await stepOf(params)
  const index = weekIndex(week)
  const sidebar = <WeekSidebar week={index} />
  const visit = <TrackVisit path={step.path} />
  const footer = <StepFooter week={index} stepId={step.id} after={afterWeek(week)} />

  if (reading) {
    const { notes, section } = reading
    return (
      <DocLayout sidebar={sidebar} toc={section.body ? tocOf(section.body) : undefined}>
        <article className="prose" data-pagefind-body>
          {visit}
          <p className="kicker">{`Step ${at + 1} of ${steps.length} · ${shortTitle(notes)} notes`}</p>
          <h1>{`${section.n}. ${section.title}`}</h1>
          {section.body && <div dangerouslySetInnerHTML={{ __html: section.body }} />}
          {footer}
        </article>
      </DocLayout>
    )
  }

  if (step.kind === 'build') {
    const apply = applyFor(week)
    // The checklist headings have no ids, so "On this page" lists only the "From the notes" groups and their own headings.
    const toc: TocItem[] = apply.flatMap(group => [
      { id: `from-${group.slug}`, title: `From the notes: ${group.title}`, level: 2 },
      ...tocOf(group.html),
    ])
    return (
      <DocLayout sidebar={sidebar} toc={toc}>
        {/* Pagefind titles a result by its h1, and ten pages share this one. A comma would split the meta value, so there is none. */}
        <article className="prose" data-pagefind-body data-pagefind-meta={`title:Build & Test · Week ${week.n}`}>
          {visit}
          <h1>Build & Test</h1>
          {week.checklists.map((list, i) => (
            <Fragment key={i}>
              <h2>{list.title}</h2>
              <Checklist items={list.items.map(task => ({ id: task.id, html: inlineHtml(task.text) }))} />
            </Fragment>
          ))}
          {apply.map(group => (
            <Fragment key={group.slug}>
              <h2 id={`from-${group.slug}`}>{`From the notes: ${group.title}`}</h2>
              <div dangerouslySetInnerHTML={{ __html: group.html }} />
            </Fragment>
          ))}
          {footer}
        </article>
      </DocLayout>
    )
  }

  // The quiz: the Self-check and the notes' intro, then the flashcards.
  return (
    <DocLayout sidebar={sidebar}>
      <article className="prose">
        {visit}
        <h1>Quiz</h1>
        {week.selfCheck && (
          <>
            <h2>Self-check</h2>
            <div dangerouslySetInnerHTML={{ __html: week.selfCheck }} />
          </>
        )}
        {quizNotes(week).map(doc => doc.quiz.intro && <div key={doc.slug} dangerouslySetInnerHTML={{ __html: doc.quiz.intro }} />)}
        <Flashcards cards={quizCards(week)} mode="quiz" weekPath={`/week/${week.n}`} />
        {footer}
      </article>
    </DocLayout>
  )
}
