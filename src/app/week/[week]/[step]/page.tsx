import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Fragment } from 'react'
import { applyFor, getWeek, inlineHtml, quizCards, quizNotes, readingSection, shortTitle, stepsOf, weeks } from '../../../../lib/content'

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

  if (reading) {
    const { notes, section } = reading
    return (
      <article>
        <p className="kicker">{`Step ${at + 1} of ${steps.length} · ${shortTitle(notes)} notes`}</p>
        <h1>{`${section.n}. ${section.title}`}</h1>
        {section.body && <div dangerouslySetInnerHTML={{ __html: section.body }} />}
      </article>
    )
  }

  if (step.kind === 'build')
    return (
      <article>
        <h1>Build & Test</h1>
        {week.checklists.map((list, i) => (
          <Fragment key={i}>
            <h2>{list.title}</h2>
            <ul>
              {list.items.map(task => (
                <li key={task.id} dangerouslySetInnerHTML={{ __html: inlineHtml(task.text) }} />
              ))}
            </ul>
          </Fragment>
        ))}
        {applyFor(week).map(group => (
          <Fragment key={group.slug}>
            <h2 id={`from-${group.slug}`}>{`From the notes: ${group.title}`}</h2>
            <div dangerouslySetInnerHTML={{ __html: group.html }} />
          </Fragment>
        ))}
      </article>
    )

  // The quiz: the card count stands in for the flashcards until they exist.
  return (
    <article>
      <h1>Quiz</h1>
      {week.selfCheck && (
        <>
          <h2>Self-check</h2>
          <div dangerouslySetInnerHTML={{ __html: week.selfCheck }} />
        </>
      )}
      {quizNotes(week).map(doc => doc.quiz.intro && <div key={doc.slug} dangerouslySetInnerHTML={{ __html: doc.quiz.intro }} />)}
      <p>{`${quizCards(week).length} cards`}</p>
    </article>
  )
}
