import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type NotesData, notesSlug, parseNotes, parsePlan, plainText, resolveNotesRefs, textSlug } from './parse'

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
  it('does not end a week at a ### heading; the heading is reported as an ignored paragraph', () => {
    const p = parsePlan(`${head}### Details\n\n**Build**\n\n- [ ] one\n`)
    expect(p.warnings).toEqual(['Week 0: paragraph ignored ("### Details")'])
    expect(p.weeks[0].checklists).toHaveLength(1)
  })
  it('lets the first matching section rule win', () => {
    const sections = (after: string) => parsePlan(`${head}**Study notes:** [A](https://x) ${after}\n`).weeks[0].notesRefs[0].sections
    expect(sections('sections 2-4 and section 9')).toEqual([2, 3, 4])
    expect(sections('section 7, and the Week 3 part of it')).toEqual([7])
    expect(sections('the Week 3 part of it')).toEqual([])
  })
})

// Review fix: tracked tasks must never vanish without a warning.
describe('content that cannot be placed is reported, never dropped silently', () => {
  const head = '# P\n\n## Week 0 — A (1 day)\n\n**Goal:** g\n\n'

  describe('an indented line after a blank line continues the list item', () => {
    it('keeps a loose list together (item with an indented second paragraph)', () => {
      const p = parsePlan(`${head}**Build**\n\n- [ ] Item one\n\n  More details here.\n\n- [ ] Item two\n- [ ] Item three\n`)
      expect(p.weeks[0].checklists).toEqual([{ title: 'Build', items: [
        { id: 'w0:item-one-more-details-here', text: 'Item one\n\nMore details here.' },
        { id: 'w0:item-two', text: 'Item two' },
        { id: 'w0:item-three', text: 'Item three' },
      ] }])
      expect(p.warnings).toEqual([])
    })
    it('also takes a nested bullet, wrapped lines and further paragraphs', () => {
      const p = parsePlan(`${head}**Build**\n\n- [ ] One\n\n  - nested bullet\n  wrapped under it\n\n  Second paragraph\n- [ ] Two\n`)
      expect(p.weeks[0].checklists[0].items).toEqual([
        { id: 'w0:one-nested-bullet-wrapped-under-it-second-paragraph', text: 'One\n\n- nested bullet\nwrapped under it\n\nSecond paragraph' },
        { id: 'w0:two', text: 'Two' },
      ])
      expect(p.warnings).toEqual([])
    })
    it('works for study items and capstone items too', () => {
      const p = parsePlan(`${head}**Study, in order**\n\n1. **Day 1:** Read it\n\n   Extra note\n2. Next\n\n**Build**\n\n- [ ] t\n\n## Final capstone checklist\n\n- [ ] A\n\n  more\n- [ ] B\n`)
      expect(p.weeks[0].study).toEqual([
        { id: 'w0:day-1-read-it-extra-note', label: 'Day 1', text: 'Read it\n\nExtra note', optional: false },
        { id: 'w0:next', text: 'Next', optional: false },
      ])
      expect(p.capstone.items).toEqual([{ id: 'capstone:a-more', text: 'A\n\nmore' }, { id: 'capstone:b', text: 'B' }])
      expect(p.warnings).toEqual([])
    })
    it('does not take an unindented paragraph', () => {
      const p = parsePlan(`${head}**Build**\n\n- [ ] One\n\nNot indented.\n`)
      expect(p.weeks[0].checklists[0].items).toEqual([{ id: 'w0:one', text: 'One' }])
      expect(p.warnings).toEqual(['Week 0: paragraph ignored ("Not indented.")'])
    })
  })

  describe('a list with no **Label** line before it', () => {
    it('is reported when a paragraph splits a list (the first list used the label up)', () => {
      const p = parsePlan(`${head}**Build**\n\n- [ ] one\n\nA note in between.\n\n- [ ] two\n- [ ] three\n`)
      expect(p.weeks[0].checklists).toEqual([{ title: 'Build', items: [{ id: 'w0:one', text: 'one' }] }])
      expect(p.warnings).toEqual([
        'Week 0: paragraph ignored ("A note in between.")',
        'Week 0: list without a **Label** line ignored ("two")',
      ])
    })
    it('is reported when it is the only list, not just "no checklists"', () => {
      const p = parsePlan(`${head}- [ ] orphan task\n- [ ] another\n`)
      expect(p.warnings).toEqual(['Week 0: list without a **Label** line ignored ("orphan task")', 'Week 0: no checklists'])
    })
    it('quotes the first 40 characters of the first item as plain text, for numbered lists too', () => {
      const p = parsePlan(`${head}1. **Day 1:** Read [the docs](https://x.y) about the thing, then do more of it\n2. Second\n`)
      expect(p.weeks[0].study).toEqual([])
      expect(p.warnings).toEqual(['Week 0: list without a **Label** line ignored ("Day 1: Read the docs about the thing, th")', 'Week 0: no checklists'])
    })
  })

  describe('a free paragraph in a week', () => {
    it('is reported once with its first 40 plain characters, and the pending label survives it', () => {
      const p = parsePlan(`${head}Free text that runs on\nover two lines and is longer than forty characters.\n\n**Build**\n\nA note under the label.\n\n- [ ] one\n`)
      expect(p.warnings).toEqual([
        'Week 0: paragraph ignored ("Free text that runs on over two lines an")',
        'Week 0: paragraph ignored ("A note under the label.")',
      ])
      expect(p.weeks[0].checklists).toEqual([{ title: 'Build', items: [{ id: 'w0:one', text: 'one' }] }])
    })
  })

  describe('a repeated Goal or Self-check', () => {
    it('keeps the first and warns where the repeat is found', () => {
      const p = parsePlan(`${head}**Goal:** second\n\n**Self-check:** one\n\n**Self-check:** two\n`)
      expect(p.weeks[0]).toMatchObject({ goal: 'g', selfCheck: 'one' })
      expect(p.warnings).toEqual([
        'Week 0: duplicate field "Goal" ignored',
        'Week 0: duplicate field "Self-check" ignored',
        'Week 0: no checklists',
      ])
    })
  })

  describe('a second capstone checklist section', () => {
    it('keeps the first and warns', () => {
      const p = parsePlan(`${head}**Build**\n\n- [ ] one\n\n## Final capstone checklist\n\nFirst.\n\n- [ ] a\n- [ ] b\n\n## Capstone checklist, again\n\nSecond.\n\n- [ ] c\n`)
      expect(p.capstone).toEqual({ intro: 'First.', items: [{ id: 'capstone:a', text: 'a' }, { id: 'capstone:b', text: 'b' }] })
      expect(p.warnings).toEqual(['duplicate capstone checklist ignored'])
    })
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

const notesFiles = readdirSync(new URL('./fixtures/', import.meta.url)).filter(f => f.endsWith('-notes.md'))
const load = (f: string) => parseNotes(fixture(f), f)

describe('Q&A pairing (12 frozen notes files)', () => {
  it('finds all 12 files', () => expect(notesFiles).toHaveLength(12))
  it.each(notesFiles)('%s pairs 12 questions with 12 answers, no warnings', f => {
    const n = load(f)
    expect(n.quiz.cards.map(c => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(n.quiz.cards.every(c => c.answer)).toBe(true)
    expect(n.warnings).toEqual([])
  })
  const doc = (qs: string, as: string) =>
    `# Study Notes — Week 0: T\n\nby · line\n\nIntro.\n\n## 1. One\n\nBody.\n\n## Apply it to the capstone\n\nDo it.\n\n## Check yourself\n\n${qs}\n\n## Answers\n\n${as}\n\n## Sources\n\n- s\n`
  it('warns, not crashes, when counts differ', () => {
    const n = parseNotes(doc('1. Q1\n2. Q2\n3. Q3', '1. A1\n2. A2'), '0-t-notes.md')
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q1', answer: 'A1' }, { n: 2, question: 'Q2', answer: 'A2' }, { n: 3, question: 'Q3' }])
    expect(n.warnings).toEqual(['question 3 has no answer', '3 questions but 2 answers'])
  })
  it('drops answers without a question', () => {
    const n = parseNotes(doc('1. Q1', '1. A1\n4. A4'), '0-t-notes.md')
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q1', answer: 'A1' }])
    expect(n.warnings).toEqual(['answer 4 has no question', '1 questions but 2 answers'])
  })
  it('pairs by number, not position, and keeps continuation lines', () => {
    const n = parseNotes(doc('2. Q2\n1. Q1', '1. A1\n   more\n2. A2'), '0-t-notes.md')
    expect(n.quiz.cards).toEqual([{ n: 2, question: 'Q2', answer: 'A2' }, { n: 1, question: 'Q1', answer: 'A1\nmore' }])
  })
})

describe('notes structure', () => {
  const async = load('1-async-notes.md')
  it('reads slug, title and numbered sections, promoting ### to ##', () => {
    expect(async).toMatchObject({ slug: 'async', file: '1-async-notes.md', title: 'Week 1: Async Python' })
    expect(async.sections.map(s => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(async.sections[2].title).toBe('Running things concurrently')
    expect(async.sections[2].body).toMatch(/^Use `TaskGroup` by default/)
    expect(async.sections[2].body).toContain('\n## Structured concurrency with `TaskGroup` (3.11+)\n')
  })
  it('handles file names and escaped titles', () => {
    expect(notesSlug('3-psql_indexes-notes.md')).toBe('psql-indexes')
    expect(load('8-testing-notes.md').sections[8].title).toBe('Test data and quality: factory_boy, coverage, time control')
  })
  it('splits "### Week N" parts out of an Apply section', () => {
    expect(load('8-testing-notes.md').applyParts.map(p => p.week)).toEqual([2, 3, 4, 6, 8])
    expect(async.applyParts).toEqual([])
  })
  it('marks lost diagrams and turns notes checkboxes into bullets', () => {
    expect(async.sections[1].body).toContain('<p class="diagram-missing">Diagram not included: event loop cycle · 4 stages</p>')
    const setup = load('0-setup-notes.md')
    expect(setup.apply).toContain('- **Task 1:** Compose file with Postgres (healthcheck) and the API service')
    expect(setup.apply).not.toContain('[ ]')
  })
  it('keeps the non-question paragraphs of Check yourself as the quiz intro', () => {
    expect(load('6-edp-notes.md').quiz.intro).toMatch(/^Answer out loud[\s\S]*For more practice/)
  })
  it('ignores # lines inside code fences', () => {
    const n = parseNotes('# Study Notes — X\n\n## 1. One\n\n```python\n# comment\n## not a heading\n```\n', '0-x-notes.md')
    expect(n.sections).toHaveLength(1)
    expect(n.sections[0].body).toContain('## not a heading')
  })
})

describe('resolveNotesRefs', () => {
  it('resolves every link in the frozen plan, short "Testing" links by URL', () => {
    const p = parsePlan(fixture('study-plan.md'))
    expect(resolveNotesRefs(p.weeks, notesFiles.map(load))).toEqual([])
    expect(p.weeks[3].notesRefs.map(r => r.slug)).toEqual(['psql-indexes', 'psql-transactions', 'testing'])
  })
  it('warns about links it cannot match and notes nobody links', () => {
    const weeks = [{ n: 0, notesRefs: [{ label: 'Nope', url: 'https://x', after: '', sections: 'all' as const }] }]
    expect(resolveNotesRefs(weeks, [{ slug: 'a', file: '0-a-notes.md', title: 'Week 0: A' }]))
      .toEqual(['Week 0: link "Nope" matches no notes file', '0-a-notes.md is not linked from any week'])
  })
})

// Rules from the brief that the notes tests above do not exercise, and the warnings that keep notes content
// from being dropped silently (the plan parser's rule).

const quiz = (qs: string, as: string) =>
  `## Apply it to the capstone\n\nDo it.\n\n## Check yourself\n\n${qs}\n\n## Answers\n\n${as}\n\n## Sources\n\n- s\n`
const notes = (middle: string, tail = quiz('1. Q', '1. A')) =>
  parseNotes(`# Study Notes — Week 0: T\n\nby · line\n\nIntro.\n\n${middle}\n\n${tail}`, '0-t-notes.md')

describe('notes header and closing sections', () => {
  it('drops the title line and the byline, and keeps the rest of the opening as the intro', () => {
    const n = notes('## 1. One\n\nBody.')
    expect(n).toMatchObject({ title: 'Week 0: T', intro: 'Intro.', apply: 'Do it.', sources: '- s', warnings: [] })
    expect(n.sections).toEqual([{ n: 1, title: 'One', body: 'Body.' }])
    expect(load('1-async-notes.md').intro).toMatch(/^After this week you will know what the asyncio event loop[\s\S]*httpx\.$/)
    expect(load('1-async-notes.md').intro).not.toContain('Mathew')
  })
  it('takes the title of the testing notes, which has no week number', () => {
    expect(load('8-testing-notes.md').title).toBe('Testing: Unit, Integration and CI')
  })
  it('matches the fixed section names in any case', () => {
    const n = notes('## 1. One\n\nBody.', quiz('1. Q', '1. A').replace('## Answers', '## ANSWERS').replace('## Sources', '## sources'))
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q', answer: 'A' }])
    expect(n.sources).toBe('- s')
    expect(n.warnings).toEqual([])
  })
  it('joins the Check yourself paragraphs around the questions with a blank line', () => {
    expect(notes('## 1. One\n\nBody.', quiz('Before.\n\n1. Q\n\nAfter.', '1. A')).quiz.intro).toBe('Before.\n\nAfter.')
  })
  it('lets an item take an indented paragraph after a blank line, but not a flush one', () => {
    const n = notes('## 1. One\n\nBody.', quiz('1. Q\n\n   more Q\n\nFlush.', '1. A\n\n   More A.\n2. B'))
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q\n\nmore Q', answer: 'A\n\nMore A.' }])
    expect(n.quiz.intro).toBe('Flush.')
  })
})

describe('notes cleanup', () => {
  it('works line by line, outside fences only', () => {
    const body = notes(
      '## 1. One\n\n#### Deep\n\n&#91;embedded content: a < b & "c"\\]\n\n* [x] done\n  - [ ] nested\n\n```md\n### kept\n- [ ] kept\n&#91;embedded content: kept\\]\n```',
    ).sections[0].body
    expect(body).toBe(
      '### Deep\n\n<p class="diagram-missing">Diagram not included: a &lt; b &amp; &quot;c&quot;</p>\n\n* done\n  - nested\n\n```md\n### kept\n- [ ] kept\n&#91;embedded content: kept\\]\n```',
    )
  })
  it('reads CRLF files, fences included', () => {
    const md = fixture('1-async-notes.md')
    expect(parseNotes(md.replace(/\n/g, '\r\n'), '1-async-notes.md')).toEqual(parseNotes(md, '1-async-notes.md'))
  })
})

describe('notes content that cannot be placed is reported, never dropped silently', () => {
  it('keeps an unnumbered section as the next step after the highest number', () => {
    const n = notes('## 1. One\n\nBody.\n\n## Pitfalls\n\nWatch out.\n\n## 3. Three\n\nLast.')
    expect(n.sections).toEqual([
      { n: 1, title: 'One', body: 'Body.' },
      { n: 4, title: 'Pitfalls', body: 'Watch out.' },
      { n: 3, title: 'Three', body: 'Last.' },
    ])
    expect(n.warnings).toEqual(['unnumbered section "Pitfalls" kept as section 4'])
  })
  it('does the same for a number that is already taken', () => {
    const n = notes('## 1. One\n\nA.\n\n## 1. Again\n\nB.\n\n## Extra\n\nC.')
    expect(n.sections.map(x => [x.n, x.title, x.body])).toEqual([[1, 'One', 'A.'], [2, 'Again', 'B.'], [3, 'Extra', 'C.']])
    expect(n.warnings).toEqual(['section number 1 appears twice; "1. Again" kept as section 2', 'unnumbered section "Extra" kept as section 3'])
  })
  it('reports each missing fixed section in order, without a warning per card', () => {
    const n = parseNotes('# Study Notes — X\n\n## 1. One\n\nBody.\n', '0-x-notes.md')
    expect(n.warnings).toEqual(['missing "## Apply it to the capstone"', 'missing "## Check yourself"', 'missing "## Answers"', 'missing "## Sources"'])
    expect([n.apply, n.sources, n.quiz.intro]).toEqual([undefined, undefined, undefined])
    expect([n.applyParts, n.quiz.cards]).toEqual([[], []])
    const noAnswers = notes('## 1. One\n\nBody.', '## Apply it to the capstone\n\nx\n\n## Check yourself\n\n1. Q\n\n## Sources\n\n- s\n')
    expect(noAnswers.quiz.cards).toEqual([{ n: 1, question: 'Q' }])
    expect(noAnswers.warnings).toEqual(['missing "## Answers"'])
  })
  it('keeps the first of a repeated fixed section', () => {
    const n = notes('## 1. One\n\nBody.', `${quiz('1. Q', '1. A')}\n## Sources\n\n- again\n\n## Answers\n\n1. other\n`)
    expect(n.sources).toBe('- s')
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q', answer: 'A' }])
    expect(n.warnings).toEqual(['duplicate "## Sources" ignored', 'duplicate "## Answers" ignored'])
  })
  it('warns about a missing title, and keeps text in front of the title as intro', () => {
    const none = parseNotes(`Intro.\n\n## 1. One\n\nBody.\n\n${quiz('1. Q', '1. A')}`, '0-t-notes.md')
    expect(none.title).toBe('')
    expect(none.intro).toBe('Intro.')
    expect(none.warnings).toEqual(['no "# Study Notes — …" title found'])
    const front = parseNotes(`front matter\n\n# Study Notes — Week 0: T\n\nby · line\n\nIntro.\n\n## 1. One\n\nBody.\n\n${quiz('1. Q', '1. A')}`, '0-t-notes.md')
    expect(front.title).toBe('Week 0: T')
    expect(front.intro).toMatch(/^front matter\s+Intro\.$/)
    expect(front.warnings).toEqual([])
  })
  it('reports text in Answers that is not an answer', () => {
    const closing = 'Read these after trying.\n\n1. A\n\nClosing words that run on past forty characters.'
    const n = notes('## 1. One\n\nBody.', quiz('1. Q', closing))
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q', answer: 'A' }])
    expect(n.warnings).toEqual(['Answers: paragraph ignored ("Read these after trying.")', 'Answers: paragraph ignored ("Closing words that run on past forty cha")'])
  })
  it('keeps the first of a repeated question or answer number, and reports it after the count', () => {
    const n = notes('## 1. One\n\nBody.', quiz('1. Q1\n2. Q2\n2. Q2 again', '1. A1\n1. A1 again\n2. A2'))
    expect(n.quiz.cards).toEqual([{ n: 1, question: 'Q1', answer: 'A1' }, { n: 2, question: 'Q2', answer: 'A2' }])
    expect(n.warnings).toEqual(['question 2 appears twice; kept the first', 'answer 1 appears twice; kept the first'])
    expect(notes('## 1. One\n\nBody.', quiz('1. Q1\n1. Q1b', '1. A1\n2. A2')).warnings)
      .toEqual(['answer 2 has no question', '1 questions but 2 answers', 'question 1 appears twice; kept the first'])
  })
  it('keeps the first of a repeated "### Week N" part; text before the first part stays in apply', () => {
    const apply = 'Lead-in.\n\n### Week 2: a\n\nOne.\n\n### Week 3: b\n\nTwo.\n\n### Week 2: again\n\nThree.'
    const n = notes('## 1. One\n\nBody.', quiz('1. Q', '1. A').replace('Do it.', apply))
    expect(n.applyParts).toEqual([{ week: 2, body: '### Week 2: a\n\nOne.' }, { week: 3, body: '### Week 3: b\n\nTwo.' }])
    expect(n.apply).toBe(apply)
    expect(n.warnings).toEqual(['"### Week 2" appears twice in Apply; kept the first'])
  })
  it('keeps a fenced block in an answer whole, and does not read its lines as items', () => {
    const answers = '1. Run it:\n   ```python\n   1. not an item\n\n       indented()\n   ```\n   Then done.\n2. Next'
    const n = notes('## 1. One\n\nBody.', quiz('1. Q1\n2. Q2', answers))
    expect(n.quiz.cards).toEqual([
      { n: 1, question: 'Q1', answer: 'Run it:\n```python\n1. not an item\n\n    indented()\n```\nThen done.' },
      { n: 2, question: 'Q2', answer: 'Next' },
    ])
    expect(n.warnings).toEqual([])
  })
})

describe('odd notes never throw and never yield empty Markdown', () => {
  const markdownOf = (n: NotesData) => [
    n.intro, n.apply, n.sources, n.quiz.intro,
    ...n.sections.map(x => x.body),
    ...n.applyParts.map(x => x.body),
    ...n.quiz.cards.flatMap(c => [c.question, c.answer]),
  ]
  it('turns empty sections into undefined', () => {
    const n = parseNotes('# Study Notes — X\n\n## 1. One\n\n## Apply it to the capstone\n\n## Check yourself\n\n## Answers\n\n## Sources\n', '0-x-notes.md')
    expect(markdownOf(n).every(m => m === undefined)).toBe(true)
    expect(n.sections).toHaveLength(1)
    expect(n.warnings).toEqual([])
  })
  it('does not make a card from a bare number', () => {
    const n = notes('## 1. One\n\nBody.', quiz('1.   \n2. Q2', '1. A\n2. B'))
    expect(n.quiz.cards).toEqual([{ n: 2, question: 'Q2', answer: 'B' }])
    expect(n.quiz.intro).toBe('1.')
    expect(n.warnings).toEqual(['answer 1 has no question', '1 questions but 2 answers'])
  })
  it('survives every real file cut off anywhere', () => {
    for (const f of notesFiles) {
      for (const cut of [0, 1, 40, 600, 4000, 20000]) {
        expect(markdownOf(parseNotes(fixture(f).slice(0, cut), f))).not.toContain('')
      }
    }
    expect(() => parseNotes('', 'x.md')).not.toThrow()
  })
})

describe('notesSlug and resolveNotesRefs (remaining rules)', () => {
  const ref = (label: string, url: string) => ({ label, url, after: '', sections: 'all' as const, slug: undefined as string | undefined })
  const asyncNotes = { slug: 'async', file: '1-async-notes.md', title: 'Week 1: Async Python' }
  it('slugs file names with or without a number, and falls back to the whole name', () => {
    expect(['1-async-notes.md', 'redis-notes.md', '10-foo_bar_baz-notes.md', 'readme.md'].map(notesSlug)).toEqual(['async', 'redis', 'foo-bar-baz', 'readme'])
  })
  it('ignores case and a "Study Notes — " prefix, then falls back to the URL of a matched link', () => {
    const refs = [ref('study notes — WEEK 1: async python', 'https://a'), ref('Async', 'https://a'), ref('Async', 'https://other')]
    expect(resolveNotesRefs([{ n: 1, notesRefs: refs }], [asyncNotes])).toEqual(['Week 1: link "Async" matches no notes file'])
    expect(refs.map(r => r.slug)).toEqual(['async', 'async', undefined])
  })
  it('does not trust a slug set earlier', () => {
    const stale = { ...ref('Nope', 'https://x'), slug: 'stale' }
    resolveNotesRefs([{ n: 0, notesRefs: [stale] }], [])
    expect(stale.slug).toBeUndefined()
  })
  it('warns when two notes files share a slug, after the other warnings', () => {
    expect(resolveNotesRefs([{ n: 1, notesRefs: [ref('Nope', 'https://x')] }], [asyncNotes, { ...asyncNotes, file: '2-async-notes.md', title: 'Week 2: Async' }]))
      .toEqual([
        'Week 1: link "Nope" matches no notes file',
        '1-async-notes.md is not linked from any week',
        '2-async-notes.md is not linked from any week',
        '2-async-notes.md has the same slug "async" as an earlier notes file',
      ])
  })
})
