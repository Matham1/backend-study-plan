'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Fragment } from 'react'
import { stepFraction, weekStats, type WeekIndex } from '../lib/progress'
import { useProgress } from '../lib/storage'
import { ProgressBar } from './progress-widgets'

/** A reading step's id is `<notes slug>-<section number>` (content.ts), so the section number is what follows the last dash. */
const sectionOf = (id: string) => id.slice(id.lastIndexOf('-') + 1)

/**
 * One sidebar link. The static export serves pages with a trailing slash and the paths here have none, so the slash is ignored.
 * `done` is for links that can be finished: true shows a ✓, false keeps its room empty so nothing moves when progress loads.
 */
function NavItem({ href, indent, done, children }: { href: string; indent?: boolean; done?: boolean; children: string }) {
  const here = usePathname().replace(/\/$/, '') === href
  return (
    <li>
      <Link href={href} className={indent ? 'indent' : undefined} aria-current={here ? 'page' : undefined}>
        {children}
        {done !== undefined && (
          <span className="tick">
            {done && (
              <>
                <span aria-hidden="true">✓</span>
                <span className="sr-only"> (finished)</span>
              </>
            )}
          </span>
        )}
      </Link>
    </li>
  )
}

/** The week's steps, for the sidebar of every page of that week. */
export function WeekSidebar({ week }: { week: WeekIndex }) {
  const p = useProgress()
  const stats = p && weekStats(week, p)
  return (
    <nav aria-label="Steps of this week">
      <p className="side-title">{`Week ${week.n} · ${week.title}`}</p>
      <ProgressBar fraction={stats && stats.fraction} />
      <p className="side-count">{stats && `${stats.finished} of ${stats.total} steps`}</p>
      <ul className="side-list">
        {week.steps.map((step, i) => (
          <Fragment key={step.id}>
            {step.group && step.group !== week.steps[i - 1]?.group && <li className="side-group">{step.group}</li>}
            <NavItem href={step.path} indent={!!step.group} done={!!p && stepFraction(week, step, p) === 1}>
              {step.kind === 'reading' ? `${sectionOf(step.id)} · ${step.title}` : step.title}
            </NavItem>
          </Fragment>
        ))}
      </ul>
    </nav>
  )
}

/** The sidebar of every page that isn't a week's: all the weeks, then the rest of the site. */
export function WeeksNav({ weeks }: { weeks: WeekIndex[] }) {
  const p = useProgress()
  return (
    <nav aria-label="Weeks">
      <ul className="side-list">
        {weeks.map(w => (
          <NavItem key={w.n} href={`/week/${w.n}`} done={!!p && weekStats(w, p).fraction === 1}>
            {`Week ${w.n} · ${w.title}`}
          </NavItem>
        ))}
        <li className="side-group">More</li>
        <NavItem href="/capstone">Capstone</NavItem>
        <NavItem href="/review">Review</NavItem>
        <NavItem href="/progress">Export / import</NavItem>
      </ul>
    </nav>
  )
}
