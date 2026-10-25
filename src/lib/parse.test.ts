import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parsePlan, plainText, textSlug } from './parse'

export const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const plan = parsePlan(fixture('study-plan.md'))

describe('week extraction (frozen study-plan.md)', () => {
  it('finds the title and ten weeks with no warnings', () => {
    expect(plan.title).toBe('Backend Study Plan (Python)')
    expect(plan.weeks.map(w => w.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(plan.warnings).toEqual([])
  })
  it('splits title and duration, keeping brackets that are not a duration', () => {
    expect(plan.weeks[0]).toMatchObject({ title: 'Setup', duration: '2–3 days' })
    expect(plan.weeks[1]).toMatchObject({ title: 'Async Python', duration: '5 days' })
    expect(plan.weeks[9]).toMatchObject({ title: 'Security (optional) + polish', duration: '5 days' })
  })
  it('reads Goal and Self-check', () => {
    expect(plan.weeks[0].goal).toMatch(/^a running FastAPI \+ Postgres skeleton/)
    expect(plan.weeks.filter(w => w.selfCheck).map(w => w.n)).toEqual([2, 3, 6])
  })
  it('labels study items and flags optional ones', () => {
    const study = plan.weeks[1].study
    expect(study).toHaveLength(7)
    expect(study[0]).toMatchObject({ label: 'Day 1', optional: false })
    expect(study[6]).toMatchObject({ label: 'Optional, to go deeper', optional: true })
  })
  it('reads notes links with their section qualifiers', () => {
    expect(plan.weeks[3].notesRefs.map(r => [r.label, r.sections])).toEqual([
      ['Week 3: PostgreSQL Indexes', 'all'],
      ['Week 3: Transactions and Concurrency in PostgreSQL', 'all'],
      ['Testing', [6, 7]],
    ])
    expect(plan.weeks[2].notesRefs[1].sections).toEqual([1, 2, 3, 4, 5])
    expect(plan.weeks[4].notesRefs[1].sections).toEqual([])
    expect(plan.weeks[8].notesRefs[0].sections).toEqual([8, 9, 10])
    expect(plan.weeks.flatMap(w => w.notesRefs)).toHaveLength(15)
  })
})

describe('checklist extraction', () => {
  it('keeps list titles as written', () => {
    expect(plan.weeks[0].checklists.map(c => [c.title, c.items.length])).toEqual([['Build', 4], ['Test', 1]])
    expect(plan.weeks[8].checklists.map(c => [c.title, c.items.length])).toEqual([['Build + Test', 6]])
    expect(plan.weeks[9].checklists.map(c => c.title)).toEqual(['Build'])
    expect(plan.capstone.items).toHaveLength(8)
  })
  it('derives ids from item text', () => {
    expect(plan.weeks[3].checklists[0].items[0].id).toBe('w3:seed-script-about-50k-events-and-1m-bookings')
    expect(plan.capstone.items[0].id).toBe('capstone:list-events-with-cursor-pagination-filters-and-an-index-back') // cut at 60
    expect(textSlug(plainText('`EXPLAIN (ANALYZE, BUFFERS)` on **every** [list](http://x) query'))).toBe('explain-analyze-buffers-on-every-list-query')
  })
  const week0 = (items: string[]) =>
    `# P\n\n## Week 0 — Setup (1 day)\n\n**Goal:** g\n\n**Build**\n\n${items.map(i => `- [ ] ${i}`).join('\n')}\n`
  it('keeps ids stable when an item is inserted', () => {
    const before = parsePlan(week0(['Alpha task', 'Beta task'])).weeks[0].checklists[0].items.map(i => i.id)
    const after = parsePlan(week0(['Alpha task', 'New task', 'Beta task'])).weeks[0].checklists[0].items.map(i => i.id)
    expect(after).toEqual([before[0], 'w0:new-task', before[1]])
  })
  it('suffixes repeated text within a week', () => {
    expect(parsePlan(week0(['Write tests', 'Write tests', 'Write tests'])).weeks[0].checklists[0].items.map(i => i.id))
      .toEqual(['w0:write-tests', 'w0:write-tests-2', 'w0:write-tests-3'])
  })
})

describe('plan warnings', () => {
  it('warns instead of throwing on odd weeks', () => {
    const p = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Note:** hi\n\n## Week 1 — B (1 day)\n\n**Goal:** g\n')
    expect(p.warnings).toEqual(['Week 0: unknown field "Note"', 'Week 0: no Goal', 'Week 0: no checklists', 'Week 1: no checklists'])
  })
  it('reports a plan without weeks', () => {
    expect(parsePlan('# Empty\n').warnings).toEqual(['no "## Week N — …" headings found'])
  })
})

// Rules from the brief that the tests above do not exercise.

describe('intro and capstone intro (frozen study-plan.md)', () => {
  it('keeps everything before Week 0 except the title and the byline', () => {
    expect(plan.intro).toMatch(/^## How to use this plan\n\nWork through the weeks in order/)
    expect(plan.intro).toMatch(/the rest is optional\.$/)
    expect(plan.intro).not.toContain('Mathew')
  })
  it('reads the capstone intro paragraph', () => {
    expect(plan.capstone.intro).toBe('When every box below is ticked, the plan is complete and you have a portfolio project that covers all four of your topics.')
  })
  it('builds a study item id from the whole item, label included', () => {
    expect(plan.weeks[0].study[0].id).toBe('w0:day-1-docker-docs-docker-compose-quickstart-services-volumes')
  })
})

describe('week headings', () => {
  it('needs a digit for a trailing bracket to count as the duration', () => {
    const w = parsePlan('# P\n\n## Week 0 — Polish (optional)\n').weeks[0]
    expect(w.title).toBe('Polish (optional)')
    expect(w.duration).toBeUndefined()
  })
  it('accepts an em dash, an en dash or a hyphen after the number', () => {
    const p = parsePlan('# P\n\n## Week 1 - Hyphen\n\n## Week 2 – En dash (2 days)\n\n## Week 3 — Em dash (1 day)\n')
    expect(p.weeks.map(w => [w.n, w.title, w.duration])).toEqual([[1, 'Hyphen', undefined], [2, 'En dash', '2 days'], [3, 'Em dash', '1 day']])
  })
})

describe('fences hide structure', () => {
  // Every "Fake" heading sits right after a line that must NOT close its fence (```js has an info string,
  // ~~~ is the wrong character, a bare ~~~ is shorter than ~~~~). If one closed it, the heading would
  // surface as a week or as an "unknown section" warning.
  const md = [
    '# P', '',
    '```md', '## Week 7 — Fake intro (1 day)', '```', '',
    '## Week 0 — A (1 day)', '',
    '**Goal:** g', '',
    '```md', '~~~', '## Fake A', '```js', '## Fake B', '**Note:** x', '- [ ] fake item', '```', '',
    '~~~~', '~~~', '## Fake C', '```', '## Fake D', '~~~~', '',
    '**Build**', '', '- [ ] Real item', '',
    '## Final capstone checklist', '', '```', '## Fake section', '```', '', '- [ ] Real capstone item', '',
  ].join('\n')
  const p = parsePlan(md)
  it('does not read weeks, sections, fields or items from inside a fence', () => {
    expect(p.weeks.map(w => w.n)).toEqual([0])
    expect(p.weeks[0].checklists).toEqual([{ title: 'Build', items: [{ id: 'w0:real-item', text: 'Real item' }] }])
    expect(p.warnings).toEqual([])
  })
  it('keeps fenced text verbatim in the intros', () => {
    expect(p.intro).toBe('```md\n## Week 7 — Fake intro (1 day)\n```')
    expect(p.capstone).toEqual({ intro: '```\n## Fake section\n```', items: [{ id: 'capstone:real-capstone-item', text: 'Real capstone item' }] })
  })
})

describe('plan warnings (remaining rules)', () => {
  const head = '# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n'
  it('flags unknown sections and duplicate weeks, keeping the first week', () => {
    const p = parsePlan(`${head}**Build**\n\n- [ ] one\n\n## Week 0 — Again (1 day)\n\n**Goal:** other\n\n## Appendix\n\ntext\n\n## FINAL Capstone Checklist\n\nDone when:\n\n- [ ] first\n`)
    expect(p.warnings).toEqual(['Week 0: duplicate week number', 'unknown section "Appendix" ignored'])
    expect(p.weeks).toHaveLength(1)
    expect(p.weeks[0]).toMatchObject({ title: 'A', goal: 'g' })
    expect(p.capstone).toEqual({ intro: 'Done when:', items: [{ id: 'capstone:first', text: 'first' }] })
  })
  it('flags a label with no list after it', () => {
    expect(parsePlan(`${head}**Build**\n\n- [ ] one\n\n**Test**\n`).warnings).toEqual(['Week 0: "Test" is not followed by a list'])
    expect(parsePlan(`${head}**Build**\n\n**Test**\n\n- [ ] one\n`).warnings).toEqual(['Week 0: "Build" is not followed by a list'])
  })
  it('only treats a numbered list under a Study label as study items', () => {
    const p = parsePlan(`${head}**Build**\n\n1. one\n\n**Study, in order**\n\n1. two\n\n**Test**\n\n- [ ] t\n`)
    expect(p.warnings).toEqual(['Week 0: "Build" is not followed by a list'])
    expect(p.weeks[0].study.map(s => s.text)).toEqual(['two'])
    expect(p.weeks[0].checklists.map(c => c.title)).toEqual(['Test'])
  })
  it('warns about text after a notes link that is not a section qualifier', () => {
    const p = parsePlan(`${head}**Study notes:** [A](https://x) (days 1–2), and then [B](https://y) only the intro\n\n**Build**\n\n- [ ] t\n`)
    expect(p.weeks[0].notesRefs.map(r => [r.label, r.url, r.sections])).toEqual([['A', 'https://x', 'all'], ['B', 'https://y', 'all']])
    expect(p.weeks[0].notesRefs[0].after).toBe(' (days 1–2), and then') // only trailing whitespace is trimmed
    expect(p.warnings).toEqual([expect.stringMatching(/^Week 0: couldn't read " ?only the intro" after "B"; using all sections$/)])
  })
  it('treats ### headings as ordinary text inside a week', () => {
    const p = parsePlan(`${head}### Details\n\n**Build**\n\n- [ ] one\n`)
    expect(p.warnings).toEqual([])
    expect(p.weeks[0].checklists).toHaveLength(1)
  })
  it('lets the first matching section rule win', () => {
    const sections = (after: string) => parsePlan(`${head}**Study notes:** [A](https://x) ${after}\n`).weeks[0].notesRefs[0].sections
    expect(sections('sections 2-4 and section 9')).toEqual([2, 3, 4])
    expect(sections('section 7, and the Week 3 part of it')).toEqual([7])
    expect(sections('the Week 3 part of it')).toEqual([])
  })
})

describe('odd input never throws and never yields empty Markdown', () => {
  it('turns empty fields and intros into undefined', () => {
    const p = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Goal:**\n\n**Self-check:**   \n\n**Build**\n\n- [ ] t\n')
    expect(p.intro).toBeUndefined()
    expect(p.capstone.intro).toBeUndefined()
    expect(p.weeks[0].goal).toBeUndefined()
    expect(p.weeks[0].selfCheck).toBeUndefined()
    expect(p.warnings).toEqual(['Week 0: no Goal'])
  })
  it('keeps a capstone intro that has no items after it', () => {
    const p = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n## Final capstone checklist\n\nOne line.\nTwo lines.') // no final newline
    expect(p.capstone).toEqual({ intro: 'One line.\nTwo lines.', items: [] })
  })
  it('reads ticked boxes and * or + bullets as checklist items too', () => {
    const p = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n**Build**\n\n- [x] Done\n* [ ] Star\n+ [X] Plus\n')
    expect(p.weeks[0].checklists[0].items.map(i => i.text)).toEqual(['Done', 'Star', 'Plus'])
  })
  it('joins wrapped lines of an item', () => {
    const p = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n**Build**\n\n- [ ] Alpha\n  continues\n- [ ] Beta\n')
    expect(p.weeks[0].checklists[0].items).toEqual([
      { id: 'w0:alpha-continues', text: 'Alpha\ncontinues' },
      { id: 'w0:beta', text: 'Beta' },
    ])
  })
  it('reads CRLF files, fences included', () => {
    const p = parsePlan('# P\r\n\r\n## Week 0 — A (1 day)\r\n\r\n**Goal:** g\r\n\r\n```\r\n## Week 1 — Fake (1 day)\r\n```\r\n\r\n**Build**\r\n\r\n- [ ] Alpha\r\n')
    expect(p.weeks.map(w => w.n)).toEqual([0])
    expect(p.weeks[0].checklists[0].items).toEqual([{ id: 'w0:alpha', text: 'Alpha' }])
    expect(p.warnings).toEqual([])
  })
  it('shares one id scope per week between study items and checklists', () => {
    const w = parsePlan('# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n**Study**\n\n1. Read it\n2. **Day 2:** Read it\n\n**Build**\n\n- [ ] Read it\n').weeks[0]
    expect(w.study).toMatchObject([{ id: 'w0:read-it', optional: false }, { id: 'w0:day-2-read-it', label: 'Day 2', text: 'Read it' }])
    expect(w.checklists[0].items[0].id).toBe('w0:read-it-2')
  })
})

describe('plainText and textSlug', () => {
  it('plainText drops markup, resolves links, escapes and numeric entities, keeps underscores', () => {
    expect(plainText('**Day 1:** see [the docs](https://x.y/z), `a_b`  and\n\\_c\\_ &#91;x&#93; &#x5B;')).toBe('Day 1: see the docs, a_b and _c_ [x] [')
  })
  it('plainText leaves an absurd numeric entity alone instead of throwing', () => {
    expect(plainText('a &#99999999; b')).toBe('a &#99999999; b')
  })
  it('textSlug folds compatibility characters, cuts at max, then trims dashes again', () => {
    expect(textSlug('ﬁx  it!')).toBe('fix-it')
    expect(textSlug('--A--')).toBe('a')
    expect(textSlug('Ab cd efg', 6)).toBe('ab-cd')
    expect(textSlug('')).toBe('')
  })
})
