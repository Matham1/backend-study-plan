import type { Metadata } from 'next'
import Link from 'next/link'
import { DocLayout } from '../components/chrome'
import { WeeksNav } from '../components/nav'
import { weekIndexes } from '../lib/content'

export const metadata: Metadata = { title: 'Page not found' }

// Next builds this into out/404.html, which GitHub Pages serves for every address with no page: an old bookmark, say, after
// the notes were renumbered. It sits in the root layout, so the stored theme applies, which Next's own 404 page would ignore.
export default function NotFound() {
  return (
    <DocLayout sidebar={<WeeksNav weeks={weekIndexes()} />}>
      <article className="prose">
        <h1>Page not found</h1>
        <p>{"This page doesn't exist. It may have moved when the notes were renumbered."}</p>
        <p>
          <Link href="/">Go to the dashboard</Link>
        </p>
      </article>
    </DocLayout>
  )
}
