'use client'

// The home page's progress: overall, the current week, cards due, and every week. Until `useProgress()` has the
// browser's state (null on the server and before mount) no number is written and every bar is an empty track.
import Link from 'next/link'
import { currentWeek, dueCardIds, overallFraction, today, weekStats, type Progress, type WeekIndex } from '../lib/progress'
import { useProgress } from '../lib/storage'
import { ProgressBar } from './progress-widgets'

/** A whole percent that reads 100 only when the fraction is exactly 1, so a week one card short isn't shown as finished. */
const percent = (fraction: number) => (fraction === 1 ? 100 : Math.min(99, Math.round(fraction * 100)))

/** Where Continue goes: the step last visited, in any week; if there is none, the start of the first week. */
function resumeLink(weeks: WeekIndex[], p: Progress) {
  const step = weeks.flatMap(w => w.steps).find(s => s.path === p.lastVisited)
  if (step) return { href: step.path, label: `Continue: ${step.title}` }
  return { href: `/week/${weeks[0].n}`, label: `Start: Week ${weeks[0].n} · ${weeks[0].title}` }
}

/** The inside of the Current week card, once progress is known. `week` is undefined when no Build & Test box is left. */
function CurrentWeek({ weeks, week, p }: { weeks: WeekIndex[]; week?: WeekIndex; p: Progress }) {
  if (!week)
    return (
      <>
        <h2 className="card-title">Plan complete</h2>
        <Link className="btn primary" href="/capstone">
          Capstone
        </Link>
      </>
    )
  const stats = weekStats(week, p)
  const go = resumeLink(weeks, p)
  return (
    <>
      <h2 className="card-title">{`Week ${week.n} · ${week.title}`}</h2>
      <ProgressBar fraction={stats.fraction} />
      <p>{`${stats.finished} of ${stats.total} steps · Build & Test ${stats.tasksDone} of ${stats.tasksTotal}`}</p>
      <Link className="btn primary" href={go.href}>
        {go.label}
      </Link>
    </>
  )
}

export function Dashboard({ weeks, cardIds, aboutHtml }: { weeks: WeekIndex[]; cardIds: string[]; aboutHtml?: string }) {
  const p = useProgress()
  const overall = p && overallFraction(weeks, p)
  const current = p ? currentWeek(weeks, p) : undefined
  const due = p ? dueCardIds(cardIds, p, today()).length : undefined
  return (
    <>
      <p className="overall">{overall === null ? 'Overall progress' : `Overall progress · ${percent(overall)}%`}</p>
      <ProgressBar fraction={overall} />

      <div className="dash-top">
        <div className="card">
          <p className="kicker">Current week</p>
          {p && <CurrentWeek weeks={weeks} week={current} p={p} />}
        </div>
        <div className="card">
          <p className="kicker">Review</p>
          {due !== undefined && (
            <h2 className="card-title">{due ? `${due} ${due === 1 ? 'card' : 'cards'} due` : 'Nothing due'}</h2>
          )}
          <Link className="btn primary" href="/review">
            Start review
          </Link>
        </div>
      </div>

      {/* role="list" because Safari drops the list semantics of a list with no bullets. */}
      <ul className="week-grid" role="list" aria-label="Progress by week">
        {weeks.map(w => {
          const stats = p && weekStats(w, p)
          const done = !!stats && stats.fraction === 1
          const here = w === current
          return (
            <li key={w.n}>
              <Link href={`/week/${w.n}`} className={here ? 'week-card current' : 'week-card'} aria-current={here ? 'step' : undefined}>
                <span className="week-meta">{w.duration ? `Week ${w.n} · ${w.duration}` : `Week ${w.n}`}</span>
                {w.title}
                <ProgressBar fraction={stats && stats.fraction} />
                <span className={done ? 'week-pct done' : 'week-pct'}>{stats && (done ? '✓ Done' : `${percent(stats.fraction)}%`)}</span>
              </Link>
            </li>
          )
        })}
      </ul>

      {aboutHtml && (
        <details>
          <summary>About this plan</summary>
          <div dangerouslySetInnerHTML={{ __html: aboutHtml }} />
        </details>
      )}
    </>
  )
}
