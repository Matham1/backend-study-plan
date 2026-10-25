import Link from 'next/link'
import { weeks } from '../lib/content'

export default function Home() {
  return (
    <ul>
      {weeks.map(w => (
        <li key={w.n}>
          <Link href={`/week/${w.n}`}>{`Week ${w.n} · ${w.title}`}</Link>
        </li>
      ))}
    </ul>
  )
}
