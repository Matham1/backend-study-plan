'use client'

// The flashcards of a week's quiz and of the Review page (spec 7.2 item 4, 7.4, 8.2). Until `useProgress()` has the
// browser's state (null on the server and before mount) it is an empty box: no card and no number.
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { Card } from '../lib/content'
import { cardKeyAction, dueCardIds, nextDue, rate, today, type Progress } from '../lib/progress'
import { update, useProgress } from '../lib/storage'

type Mode = 'quiz' | 'review'
/**
 * One run through a deck, in memory. `results` is card id -> knew it; the first card without a result is on screen.
 * ponytail: the first pass seeds `results` from the saved states once, so a card rated in another tab during the run
 * is counted after a reload. Derive them from `p.cards` on every render if two tabs on one quiz ever matter.
 */
type Run = { deck: Card[]; results: Record<string, boolean> }

/**
 * Where a visit starts. The quiz resumes its first pass at the first unrated card, with the results rebuilt from the
 * saved states (box 0 = knew it); with every card rated it starts on a summary (null). Review takes the cards due
 * now, once, so a card rated during the run doesn't leave the deck.
 */
function firstRun(cards: Card[], mode: Mode, p: Progress): Run | null {
  if (mode === 'review') {
    const byId = new Map(cards.map(c => [c.id, c]))
    return { deck: dueCardIds([...byId.keys()], p, today()).map(id => byId.get(id)!), results: {} }
  }
  if (cards.every(c => p.cards[c.id])) return null
  return { deck: cards, results: Object.fromEntries(cards.filter(c => p.cards[c.id]).map(c => [c.id, p.cards[c.id].box === 0])) }
}

/** A `YYYY-MM-DD` day as "Tue, 27 Oct", built from its parts: parsing the string would read it as UTC. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const Answer = ({ card }: { card: Card }) =>
  card.answerHtml ? <div dangerouslySetInnerHTML={{ __html: card.answerHtml }} /> : <p className="fc-none">No answer in the notes</p>

/** Questions with their answers one click away. */
function Questions({ cards }: { cards: Card[] }) {
  if (!cards.length) return null
  return (
    <div>
      {cards.map(card => (
        <details key={card.id}>
          <summary dangerouslySetInnerHTML={{ __html: card.questionHtml }} />
          <Answer card={card} />
        </details>
      ))}
    </div>
  )
}

function Deck({ p, cards, mode, weekPath }: { p: Progress; cards: Card[]; mode: Mode; weekPath?: string }) {
  const [run, setRun] = useState(() => firstRun(cards, mode, p))
  const [flipped, setFlipped] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const card = run?.deck.find(c => run.results[c.id] === undefined)

  // Focus rests on the box, never on a button that is about to go, so the next Space flips the card.
  const focusBox = () => box.current?.focus({ preventScroll: true })
  const start = (next: Run) => {
    setRun(next)
    focusBox()
  }
  const flip = () => {
    setFlipped(f => !f)
    focusBox()
  }
  const rateCard = (c: Card, knew: boolean) => {
    update(q => ({ ...q, cards: { ...q.cards, [c.id]: rate(q.cards[c.id], knew, today()) } }))
    setRun(r => r && { ...r, results: { ...r.results, [c.id]: knew } })
    setFlipped(false)
    focusBox()
  }

  useEffect(() => {
    if (!card) return
    const onKey = (e: KeyboardEvent) => {
      const action = cardKeyAction(
        { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, target: e.target as HTMLElement | null },
        flipped,
      )
      if (!action) return
      e.preventDefault() // so Space never scrolls the page
      if (e.repeat) return // a held key flips or rates once
      if (action === 'flip') flip()
      else rateCard(card, action === 'knew')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // flip and rateCard use only setters, a ref and module functions, so the copy from any render does the same
  }, [card, flipped])

  const { deck = [], results = {} } = run ?? {}
  const missed = deck.filter(c => results[c.id] === false)
  const knew = deck.filter(c => results[c.id]).length

  let body
  if (!run) {
    // Every card of the quiz was rated before this visit: where they stand now.
    const inReview = cards.filter(c => p.cards[c.id]?.box) // box 1-3
    body = (
      <>
        <p className="fc-head">{`${cards.filter(c => p.cards[c.id]?.box === 0).length} known · ${inReview.length} in review`}</p>
        <Questions cards={inReview} />
        <div className="fc-actions">
          <button type="button" className="btn primary" onClick={() => start({ deck: cards, results: {} })}>
            Start over
          </button>
        </div>
      </>
    )
  } else if (!deck.length) {
    const next = nextDue(cards.map(c => c.id), p)
    body = <p>{next ? `Nothing due. Next card comes back on ${dayLabel(next)}.` : 'No cards are scheduled for review.'}</p>
  } else if (!card) {
    body = (
      <>
        <p className="fc-head">{mode === 'review' ? `Reviewed ${deck.length} · knew ${knew}` : `${knew} of ${deck.length} known`}</p>
        <Questions cards={missed} />
        <div className="fc-actions">
          {missed.length > 0 && (
            <button type="button" className="btn primary" onClick={() => start({ deck: missed, results: {} })}>
              {`Go through the ${missed.length} again now`}
            </button>
          )}
          {weekPath && (
            <Link className={missed.length ? 'btn' : 'btn primary'} href={weekPath}>
              Back to the week
            </Link>
          )}
        </div>
      </>
    )
  } else {
    const at = `Card ${knew + missed.length + 1} of ${deck.length}`
    body = (
      <>
        <p className="fc-head">{mode === 'review' ? at : `${at} · knew ${knew} · didn't ${missed.length}`}</p>
        <p className="kicker">{card.label}</p>
        <div dangerouslySetInnerHTML={{ __html: card.questionHtml }} />
        {flipped ? (
          <>
            <hr />
            <Answer card={card} />
            <div className="fc-actions">
              <button type="button" className="btn" onClick={() => rateCard(card, true)}>
                Knew it <kbd>1</kbd>
              </button>
              <button type="button" className="btn" onClick={() => rateCard(card, false)}>
                {"Didn't know"} <kbd>2</kbd>
              </button>
            </div>
          </>
        ) : (
          <div className="fc-actions">
            <button type="button" className="btn primary" onClick={flip}>
              Show answer <kbd>Space</kbd>
            </button>
          </div>
        )}
      </>
    )
  }
  return (
    <div className="flashcards" ref={box} tabIndex={-1} aria-live="polite">
      {body}
    </div>
  )
}

export function Flashcards(props: { cards: Card[]; mode: Mode; weekPath?: string }) {
  const p = useProgress()
  return p ? <Deck p={p} {...props} /> : <div className="flashcards" aria-busy="true" />
}
