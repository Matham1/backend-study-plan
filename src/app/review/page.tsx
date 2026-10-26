import type { Metadata } from 'next'
import { DocLayout } from '../../components/chrome'
import { Flashcards } from '../../components/Flashcards'
import { WeeksNav } from '../../components/nav'
import { allCards, weekIndexes } from '../../lib/content'

export const metadata: Metadata = { title: 'Review' }

export default function Review() {
  return (
    <DocLayout sidebar={<WeeksNav weeks={weekIndexes()} />}>
      <article className="prose">
        <h1>Review</h1>
        <Flashcards cards={allCards()} mode="review" />
      </article>
    </DocLayout>
  )
}
