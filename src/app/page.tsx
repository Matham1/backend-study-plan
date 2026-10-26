import { DocLayout } from '../components/chrome'
import { Dashboard } from '../components/Dashboard'
import { WeeksNav } from '../components/nav'
import { allCards, plan, weekIndexes } from '../lib/content'

export default function Home() {
  const weeks = weekIndexes()
  return (
    <DocLayout sidebar={<WeeksNav weeks={weeks} />}>
      <article className="prose">
        <h1>{plan.title}</h1>
        <Dashboard weeks={weeks} cardIds={allCards().map(card => card.id)} aboutHtml={plan.intro} />
      </article>
    </DocLayout>
  )
}
