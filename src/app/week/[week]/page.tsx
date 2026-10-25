import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Fragment } from 'react'
import { DocLayout } from '../../../components/chrome'
import { WeekSidebar } from '../../../components/nav'
import { getWeek, inlineHtml, linkedNotes, refTarget, shortTitle, weekIndex, weeks } from '../../../lib/content'

export const dynamicParams = false
export const generateStaticParams = () => weeks.map(w => ({ week: String(w.n) }))

type Props = { params: Promise<{ week: string }> }

async function weekOf(params: Props['params']) {
  const week = getWeek(Number((await params).week))
  if (!week) notFound()
  return week
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const week = await weekOf(params)
  return { title: `Week ${week.n} · ${week.title}` }
}

export default async function Overview({ params }: Props) {
  const week = await weekOf(params)
  const docs = linkedNotes(week)
  const at = weeks.indexOf(week)
  const [prev, next] = [weeks[at - 1], weeks[at + 1]]
  return (
    <DocLayout sidebar={<WeekSidebar week={weekIndex(week)} />}>
      <article className="prose">
        <p className="kicker">{week.duration ? `Week ${week.n} · ${week.duration}` : `Week ${week.n}`}</p>
        <h1>{week.title}</h1>
        {week.goal && (
          <p>
            <strong>Goal:</strong> <span dangerouslySetInnerHTML={{ __html: inlineHtml(week.goal) }} />
          </p>
        )}
        {week.notesRefs.length > 0 && (
          <p>
            <strong>Study notes:</strong>
            {week.notesRefs.map((ref, i) => {
              const { href, external } = refTarget(week, ref)
              return (
                <Fragment key={i}>
                  {' '}
                  {external ? <a href={href}>{ref.label}</a> : <Link href={href}>{ref.label}</Link>}
                  {ref.after}
                </Fragment>
              )
            })}
          </p>
        )}
        {docs.some(doc => doc.intro) && <h2>What the notes cover</h2>}
        {docs.map(
          doc =>
            doc.intro && (
              <Fragment key={doc.slug}>
                <h3>{shortTitle(doc)}</h3>
                <div dangerouslySetInnerHTML={{ __html: doc.intro }} />
              </Fragment>
            ),
        )}
        <h2>Study, in order</h2>
        <ol>
          {week.study.map(item => (
            <li key={item.id}>
              {item.label && <strong>{`${item.label}:`}</strong>} <span dangerouslySetInnerHTML={{ __html: inlineHtml(item.text) }} />
              {item.optional && (
                <>
                  {' '}
                  <span className="tag">optional</span>
                </>
              )}
            </li>
          ))}
        </ol>
        {docs.map(
          doc =>
            doc.sources && (
              <details key={doc.slug}>
                <summary>{`Sources: ${shortTitle(doc)}`}</summary>
                <div dangerouslySetInnerHTML={{ __html: doc.sources }} />
              </details>
            ),
        )}
        <nav className="pager" aria-label="Previous and next week">
          {prev && <Link href={`/week/${prev.n}`}>{`← Week ${prev.n} · ${prev.title}`}</Link>}{' '}
          {next && <Link href={`/week/${next.n}`}>{`Week ${next.n} · ${next.title} →`}</Link>}
        </nav>
      </article>
    </DocLayout>
  )
}
