import Link from 'next/link'
import { DocLayout } from '../components/chrome'
import { WeeksNav } from '../components/nav'
import { weekIndexes } from '../lib/content'

export default function Home() {
  const weeks = weekIndexes()
  return (
    <DocLayout sidebar={<WeeksNav weeks={weeks} />}>
      <article className="prose">
        <h1>Backend Study Plan</h1>
        <ul>
          {weeks.map(w => (
            <li key={w.n}>
              <Link href={`/week/${w.n}`}>{`Week ${w.n} · ${w.title}`}</Link>
            </li>
          ))}
        </ul>
      </article>
    </DocLayout>
  )
}
