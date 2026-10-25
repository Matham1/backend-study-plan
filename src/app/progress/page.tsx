import type { Metadata } from 'next'
import { DocLayout } from '../../components/chrome'
import { WeeksNav } from '../../components/nav'
import { ProgressIO } from '../../components/ProgressIO'
import { weekIndexes } from '../../lib/content'

export const metadata: Metadata = { title: 'Export / import progress' }

export default function ProgressPage() {
  return (
    <DocLayout sidebar={<WeeksNav weeks={weekIndexes()} />}>
      <article className="prose">
        <h1>Export / import progress</h1>
        <p>Your progress is saved in this browser only. Export it to keep a copy or to move it to another device, then import the file there.</p>
        <ProgressIO />
      </article>
    </DocLayout>
  )
}
