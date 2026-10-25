'use client'

// The widgets that read and write saved progress. Until `useProgress()` has the browser's state (it is null on the
// server and before mount) each one renders a neutral placeholder, so no page ever shows a made-up 0%.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { dueCardIds, today, type WeekIndex } from '../lib/progress'
import { update, useProgress, useSaveFailed } from '../lib/storage'

/** `ticks` with `key` set, or taken out. */
function withKey(ticks: Record<string, true>, key: string, on: boolean): Record<string, true> {
  const next = { ...ticks }
  if (on) next[key] = true
  else delete next[key]
  return next
}

/**
 * A bar from 0 to 1. `null` (progress not read yet) is an empty track: no fill, never a made-up 0%. It is decorative
 * (hidden from screen readers) because every use writes the same number beside it.
 */
export function ProgressBar({ fraction }: { fraction: number | null }) {
  return (
    <div className="bar" aria-hidden="true">
      {fraction !== null && <span style={{ width: `${fraction * 100}%` }} />}
    </div>
  )
}

/** A checkbox per item, saved under its id. `html` is already inline (the page unwraps it on the server). */
export function Checklist({ items }: { items: { id: string; html: string; label?: string; optional?: boolean }[] }) {
  const p = useProgress()
  return (
    <ul className="checklist">
      {items.map(item => (
        <li key={item.id}>
          <label>
            <input
              type="checkbox"
              checked={!!p?.checks[item.id]}
              disabled={!p}
              onChange={e => {
                const on = e.currentTarget.checked
                update(q => ({ ...q, checks: withKey(q.checks, item.id, on) }))
              }}
            />
            <span>
              {item.label && (
                <>
                  <strong>{`${item.label}:`}</strong>{' '}
                </>
              )}
              <span dangerouslySetInnerHTML={{ __html: item.html }} />
              {item.optional && (
                <>
                  {' '}
                  <span className="tag">optional</span>
                </>
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}

/**
 * The bottom of a step: back to the previous step, and on to the next. A reading step also holds its read mark.
 * On the last step `after` is where the week leads. Before progress loads the reading step shows a plain
 * "Next →" link, which is true whether or not the step was read.
 */
export function StepFooter({
  week,
  stepId,
  after,
}: {
  week: WeekIndex
  stepId: string
  after?: { path: string; title: string }
}) {
  const router = useRouter()
  const p = useProgress()
  const at = week.steps.findIndex(step => step.id === stepId)
  const prev = week.steps[at - 1]
  const next = week.steps[at + 1] ?? after
  const marked = week.steps[at]?.kind === 'reading' && p !== null // a reading step whose read mark is known
  const read = !!p?.read[stepId]
  return (
    <nav className="pager" aria-label="Previous and next step" data-pagefind-ignore>
      {prev && <Link href={prev.path}>{`← ${prev.title}`}</Link>}
      <div className="pager-next">
        {/* One button for both states, so keyboard focus stays on it when "Mark as unread" is pressed. */}
        {marked && (
          <button
            type="button"
            className={read ? 'btn' : 'btn primary'}
            title={read ? undefined : next?.title}
            onClick={e => {
              // The second click of a double-click lands on this button after it has flipped, and would undo the first.
              if (e.detail > 1) return
              update(q => ({ ...q, read: withKey(q.read, stepId, !read) }))
              if (!read && next) router.push(next.path)
            }}
          >
            {read ? 'Mark as unread' : 'Mark as read · Next →'}
          </button>
        )}
        {next && !(marked && !read) && (
          <Link className="btn primary" href={next.path} title={next.title}>
            Next →
          </Link>
        )}
      </div>
    </nav>
  )
}

/** Remembers the last step page opened, for the dashboard's Continue button. Renders nothing. */
export function TrackVisit({ path }: { path: string }) {
  useEffect(() => {
    update(p => ({ ...p, lastVisited: path }))
  }, [path])
  return null
}

/** The number of cards due today, beside "Review" in the top bar. Nothing when none are due or before progress loads. */
export function ReviewBadge({ cardIds }: { cardIds: string[] }) {
  const p = useProgress()
  const due = p ? dueCardIds(cardIds, p, today()).length : 0
  if (!due) return null
  return (
    <>
      {' '}
      <span className="badge">
        {due}
        <span className="sr-only"> due</span>
      </span>
    </>
  )
}

/** Tells the learner when progress isn't being written to the browser. The live region is always there, so its text is announced when it appears. */
export function SaveWarning() {
  const failed = useSaveFailed()
  return <div role="status">{failed && <p className="save-warning">{"Progress can't be saved in this browser."}</p>}</div>
}
