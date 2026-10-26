import type { Metadata } from 'next'
import { DocLayout } from '../../components/chrome'
import { WeeksNav } from '../../components/nav'
import { CapstoneWeeks, Checklist } from '../../components/progress-widgets'
import { inlineHtml, plan, weekIndexes } from '../../lib/content'

export const metadata: Metadata = { title: 'Capstone' }

export default function Capstone() {
  const weeks = weekIndexes()
  const { intro, items } = plan.capstone
  return (
    <DocLayout sidebar={<WeeksNav weeks={weeks} />}>
      <article className="prose">
        <h1>Capstone</h1>
        {intro && <div dangerouslySetInnerHTML={{ __html: intro }} />}
        <Checklist items={items.map(item => ({ id: item.id, html: inlineHtml(item.text) }))} />
        <h2>Build & Test by week</h2>
        <CapstoneWeeks weeks={weeks} />
      </article>
    </DocLayout>
  )
}
