# Study Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static Next.js site that turns `./content` (the study plan plus 12 notes files) into step-by-step week pages. It has saved progress, an end-of-week flashcard quiz, a spaced-repetition review page, search, and progress export/import.

**Architecture:**
- **Parsing:** a pure parser (`src/lib/parse.ts`) splits each Markdown file into structured data.
- **Rendering:** a Velite custom loader passes that data through Velite schemas, which render every Markdown chunk to HTML with GFM, heading ids and Shiki.
- **Pages:** a server-only `src/lib/content.ts` turns Velite's output into weeks and steps for statically generated App Router pages.
- **Progress:** client components read and write progress through one storage module (`storage.ts`) and pure rules (`progress.ts`).

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript 5, Velite 0.4, rehype-pretty-code 0.14 + Shiki 4, rehype-slug 6, Pagefind 1.5, Vitest 5, GitHub Actions + GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-25-study-site-design.md` (read it first; section numbers below refer to it).

**Where this plan differs from the spec:**
- **Names and file:** field names and file split follow the Interfaces blocks below, which replace the sketch in spec §9.1 and §10. For example, the Study notes line is rendered from structured `notesRefs`, not a pre-rewritten HTML string.
- **Next config:** it's `next.config.mjs`, not `.ts`, because Velite's documented Next.js setup needs top-level await.

## Global Constraints

- **Content:** `content/*.md` is never edited. The parser adapts to it.
- **Next config:** `next.config.mjs` sets `output: 'export'`, `trailingSlash: true` and `basePath: process.env.NEXT_PUBLIC_BASE_PATH || ''`.
- **Loading and highlighting:** content loads only through Velite (no Contentlayer). Code is highlighted only by rehype-pretty-code with `theme: { light: 'github-light', dark: 'github-dark' }`.
- **Dependencies:**
  - Runtime: `next@^16.4`, `react@^19.3`, `react-dom@^19.3`, `velite@^0.4.0`, `rehype-pretty-code@^0.14.5`, `shiki@^4.5`, `rehype-slug@^6`.
  - Dev: `typescript@^5`, `@types/node@^24`, `@types/react@^19`, `@types/react-dom@^19`, `vitest@^5`, `pagefind@^1.5`.
  - Nothing else: no UI, CSS, state or schema library.
- **Storage:**
  - localStorage is touched only by `src/lib/storage.ts` and the `THEME_SCRIPT` string it exports, always inside try/catch.
  - Components read progress after mount through `useSyncExternalStore`.
  - Keys: `backend-study:progress:v1`, `backend-study:theme`, and backups named `backend-study:progress:v1:backup-<ISO time>`.
- **Client imports:** client components never import *values* from `src/lib/content.ts`, because that would ship all content to the browser. They receive data as props. `import type` is fine.
- **Markdown fields from the parser:** never `''`. An empty field becomes `undefined`, because Velite rejects empty Markdown and `strict: true` turns that into a build failure.
- **Reading layout:** body text 17px (`1.0625rem`), line-height 1.6, reading column max 75ch. Light and dark follow the system, and the toggle overrides. Below 800px the sidebar becomes a drawer.
- **Flashcard keys:**
  - Space toggles the flip.
  - `1` = Knew it and `2` = Didn't know, only after the flip.
  - Ignored while focus is in an input, textarea, select or contenteditable element, or when Ctrl, Meta or Alt is held.
  - Space on a focused `<button>` is left to the browser.
- **Build failures:** parser warnings print as `[content] <file>: <warning>` and never fail the build. A plan with zero weeks fails it.
- **Tests and types:** `npm test` passes and `next build` type-checks cleanly at the end of every task that touches code.
- **Copy:** UI strings quoted in this plan are exact.

## Review Focus

1. **Storage blocked or full** (private mode, quota exceeded): pages keep working for the session, nothing throws, and "Progress can't be saved in this browser." appears. Pinned by Task 4 tests.
2. **GitHub Pages base path `/<repo>`:** internal links, `_next` assets, the Pagefind bundle and search-result links all resolve under the base path. Pinned by the Task 11 check.
3. **Importing a file that isn't a valid v1 export:** a readable error and no change. Valid files with unknown ids still import. Pinned by Task 4 tests.
4. **Local-date edges:** "tomorrow" starts at local midnight, and a DST change doesn't shift due dates. Pinned by Task 3 tests (Europe/Berlin, 2026-10-25).
5. **Keys while typing:** Space, 1 or 2 typed in the search box never flips or rates a card, and Space on the quiz never scrolls the page. Pinned by the Task 3 `cardKeyAction` tests and the Task 9 and Task 10 checks.

---

### Task 1: Scaffold and plan parser

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/lib/parse.ts`
- Create: `src/lib/fixtures/` (byte-for-byte copies of all 13 files in `content/`)
- Test: `src/lib/parse.test.ts`

**Interfaces:**
- Produces (`src/lib/parse.ts`):
  - `type TaskData = { id: string; text: string }`: `text` is Markdown.
  - `type StudyItemData = { id: string; label?: string; text: string; optional: boolean }`: `text` is the Markdown after the label.
  - `type NotesRef = { label: string; url: string; after: string; sections: number[] | 'all'; slug?: string }`
  - `type WeekData = { n: number; title: string; duration?: string; goal?: string; selfCheck?: string; notesRefs: NotesRef[]; study: StudyItemData[]; checklists: { title: string; items: TaskData[] }[] }`
  - `type PlanData = { title: string; intro?: string; weeks: WeekData[]; capstone: { intro?: string; items: TaskData[] }; warnings: string[] }`
  - `parsePlan(md: string): PlanData`
  - `plainText(md: string): string`: removes `*` and backticks, replaces `[text](url)` with its text, unescapes `\X`, decodes numeric entities (`&#91;` becomes `[`) and collapses whitespace. Underscores stay.
  - `textSlug(text: string, max = 60): string`: lowercases, applies NFKD, turns runs of `[^a-z0-9]` into `-`, trims dashes, cuts to `max`, then trims trailing dashes again.

- [ ] **Step 1: Scaffold**
  - Run `git init -b main`.
  - `.gitignore`: `node_modules/`, `.next/`, `out/`, `.velite/`, `.superpowers/`, `next-env.d.ts`, `*.tsbuildinfo`.
  - `package.json`:
    - name `backend-study`, `"private": true`
    - scripts `"dev": "next dev"`, `"build": "next build && pagefind --site out"`, `"preview": "pagefind --site out --serve"`, `"test": "vitest run"`
    - dependencies exactly as in Global Constraints, then run `npm install`.
  - `tsconfig.json`: the Next.js defaults (`strict: true`, `moduleResolution: "bundler"`, `noEmit`, `plugins: [{ "name": "next" }]`) plus `"paths": { "#site/content": ["./.velite"] }`. Next amends this file on its first build; accept its changes.
  - Copy `content/*.md` into `src/lib/fixtures/`.

- [ ] **Step 2: Write the failing tests** in `src/lib/parse.test.ts`

```ts
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
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run src/lib/parse.test.ts`
Expected: FAIL (`./parse` has no exports).

- [ ] **Step 4: Implement `parsePlan`, `plainText` and `textSlug` in `src/lib/parse.ts`**

These rules aren't fixed by the signatures or the tests:

- **Line scan:** fence-aware throughout. A line whose trimmed start is ```` ``` ```` or `~~~` opens a fence. The fence closes on the same character repeated at least as many times, with no info string. Nothing inside a fence is treated as structure.
- **Title and intro:**
  - Title = the first `# ` line.
  - Skip the next non-empty line if it contains ` · ` (the byline).
  - `intro` = everything up to the first week heading, including `## How to use this plan`.
- **Week heading:** `/^##\s+Week\s+(\d+)\s*[—–-]\s*(.+?)(?:\s*\(([^)]*\d[^)]*)\))?\s*$/`. The duration needs a digit, which is why `(optional)` stays in Week 9's title.
- **Other `## ` headings after the first week:**
  - A heading matching `/capstone checklist/i` gives `capstone` (its intro paragraph and its `- [ ]` items).
  - Any other heading gives the warning `unknown section "<heading>" ignored`.
- **Paragraphs inside a week:**
  - `**Label:** rest` (colon inside the bold) is a field.
    - Goal → `goal`, Study notes → `notesRefs`, Self-check → `selfCheck`.
    - Any other label gives the warning `Week N: unknown field "Label"`.
  - A line that is only `**Label**` labels the list after it:
    - a `- [ ]` list becomes a checklist titled `Label`;
    - a numbered list under a label matching `/^study\b/i` becomes `study`;
    - anything else gives the warning `Week N: "Label" is not followed by a list`.
- **Study items:**
  - Format: `N. **Label:** text`, where the label is optional.
  - `optional` = the label matches `/^optional/i`.
  - id = `w<N>:` + `textSlug(plainText(whole item))`.
- **Checklist items:** `- [ ] text`. id = `w<N>:` + `textSlug(plainText(text))`. Study items and checklists share one id scope per week, and repeats get `-2`, `-3`. Capstone items use the scope `capstone:`.
- **Notes links:**
  - Find links with `/\[([^\]]+)\]\(([^)\s]+)\)/g` in the Study notes field.
  - `after` = the text from this link's end to the next link's start (or the line end), with trailing whitespace trimmed.
  - `sections`, first match wins:
    1. `/sections?\s+(\d+)\s*[–-]\s*(\d+)/i` gives the range.
    2. `/sections?\s+(\d+)/i` gives that one number.
    3. `/\bpart of\b/i` gives `[]`.
    4. Otherwise `'all'`. Remove `(days …)` groups, the words `then` and `and`, and punctuation. If anything is still left, add the warning `Week N: couldn't read "<after>" after "<label>"; using all sections`.
- **Week warnings.** Field warnings come out as they're found. `no Goal` and then `no checklists` come out when the week ends:
  - `Week N: no Goal`
  - `Week N: no checklists`
  - `Week N: duplicate week number` (keep the first)
  - `no "## Week N — …" headings found`

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json src/lib docs
git commit -m "feat: scaffold project and parse the study plan"
```

---

### Task 2: Notes parser, Q&A pairing and link resolution

**Files:**
- Modify: `src/lib/parse.ts`, `src/lib/parse.test.ts`

**Interfaces:**
- Consumes: `NotesRef`, `plainText` and the fence-aware line scan from Task 1.
- Produces (`src/lib/parse.ts`):
  - `type CardData = { n: number; question: string; answer?: string }`
  - `type NotesData = { slug: string; file: string; title: string; intro?: string; sections: { n: number; title: string; body?: string }[]; apply?: string; applyParts: { week: number; body: string }[]; quiz: { intro?: string; cards: CardData[] }; sources?: string; warnings: string[] }`
  - `notesSlug(fileName: string): string`: `/^(?:\d+-)?(.*?)-notes\.md$/`, with `_` turned into `-`.
  - `parseNotes(md: string, fileName: string): NotesData`
  - `resolveNotesRefs(weeks: { n: number; notesRefs: NotesRef[] }[], notes: { slug: string; file: string; title: string }[]): string[]`: sets `ref.slug` in place and returns warnings.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/parse.test.ts`)

```ts
import { readdirSync } from 'node:fs'
import { notesSlug, parseNotes, resolveNotesRefs } from './parse'

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
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/lib/parse.test.ts`
Expected: FAIL (`parseNotes` is not exported).

- [ ] **Step 3: Implement `notesSlug`, `parseNotes` and `resolveNotesRefs`**

These rules aren't fixed by the tests:

- **Title and intro:** title = the first `# ` line without `/^Study Notes\s*[—–-]\s*/`. Skip the byline as in Task 1. `intro` = the text before the first `## `.
- **Sections:** split on `## ` headings outside fences.
  - `/^(\d+)\.\s+(.*)$/` is a numbered section: `title` = `plainText(rest)`, and `body` = the body with headings promoted (`###` → `##`, `####` → `###`, outside fences), then `cleanup`.
  - These names, matched case-insensitively, are the fixed sections: `Apply it to the capstone`, `Check yourself`, `Answers`, `Sources`.
  - Any other heading becomes an extra section numbered from the highest number + 1, with the warning `unnumbered section "<heading>" kept as section <n>`.
- **Missing fixed sections:** a warning for each, for example `missing "## Answers"`.
- **`cleanup(md)`** runs on every chunk, outside fences:
  - `^(\s*[-*+]\s+)\[[ xX]\]\s+` → `$1`
  - `^&#91;embedded content: (.*?)\\?\]\s*$` → `<p class="diagram-missing">Diagram not included: <html-escaped description></p>`
  - then trim, and `''` → `undefined`.
- **Apply:**
  - `apply` = `cleanup(body)` (headings are not promoted).
  - `applyParts` = each chunk that starts at a `^###\s+Week\s+(\d+)\b` line (heading included), runs to the next such line or the end, and is passed through `cleanup`.
- **Check yourself and Answers:**
  - An item is `^(\d+)[.)]\s+(.*)$` at column 0.
  - Following lines belong to the item while they are non-empty, or are indented after a blank line. Multi-line text joins with `\n` and leading indentation is stripped.
  - Other paragraphs in Check yourself, joined with a blank line and passed through `cleanup`, become `quiz.intro`. Other text in Answers is ignored.
- **Pairing:**
  - Cards follow question order. The answer is the one with the same number.
  - Warnings, in this order: `question N has no answer`, `answer N has no question`, then `Q questions but A answers` if the counts differ, and `question N appears twice; kept the first` (the same wording for answers).
- **`resolveNotesRefs`:**
  1. First pass: match `ref.label` to `notes.title`, ignoring case and a `Study Notes — ` prefix. Remember each matched URL → slug.
  2. Second pass: give unmatched refs the slug of a remembered URL.
  3. Warnings: `Week N: link "<label>" matches no notes file`, then `<file> is not linked from any week`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS, including the 12 per-file cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parse.ts src/lib/parse.test.ts
git commit -m "feat: parse notes, pair Q&A by number, resolve plan links"
```

---

### Task 3: Progress rules

**Files:**
- Create: `src/lib/progress.ts`
- Test: `src/lib/progress.test.ts`

**Interfaces:**
- Produces (`src/lib/progress.ts`). This module is pure, with no React and no storage access:
  - `type CardState = { box: 0 } | { box: 1 | 2 | 3; due: string }`
  - `type Progress = { version: 1; updatedAt: string; checks: Record<string, true>; read: Record<string, true>; cards: Record<string, CardState>; lastVisited?: string }`
  - `type StepKind = 'overview' | 'reading' | 'build' | 'quiz'`
  - `type StepRef = { kind: StepKind; id: string; path: string; title: string; group?: string }`
  - `type WeekIndex = { n: number; title: string; duration?: string; steps: StepRef[]; studyIds: string[]; taskIds: string[]; cardIds: string[] }`: `studyIds` lists only non-optional items.
  - `today(now = new Date()): string`: local `YYYY-MM-DD`
  - `addDays(day: string, days: number): string`: uses `new Date(y, m - 1, d + days)`, so it is DST-safe.
  - `rate(card: CardState | undefined, knew: boolean, day: string): CardState`: spec table 8.2
  - `isDue(card: CardState | undefined, day: string): boolean`
  - `stepFraction(week: WeekIndex, step: StepRef, p: Progress): number`: spec table 8.1. An empty list counts as 1.
  - `weekStats(week: WeekIndex, p: Progress): { fraction: number; finished: number; total: number; tasksDone: number; tasksTotal: number }`
  - `overallFraction(weeks: WeekIndex[], p: Progress): number`: the mean of week fractions, or 0 when there are no weeks.
  - `currentWeek(weeks: WeekIndex[], p: Progress): WeekIndex | undefined`: the first week with an unticked `taskIds` entry.
  - `dueCardIds(cardIds: string[], p: Progress, day: string): string[]`: sorted by due date; ties keep input order.
  - `nextDue(cardIds: string[], p: Progress): string | undefined`: the earliest due date among box 1–3 cards.
  - `cardKeyAction(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target: { tagName?: string; isContentEditable?: boolean } | null }, flipped: boolean): 'flip' | 'knew' | 'didnt' | null`

- [ ] **Step 1: Write the failing tests**

```ts
process.env.TZ = 'Europe/Berlin' // EU DST ends on Sunday 2026-10-25
import { describe, expect, it } from 'vitest'
import { addDays, cardKeyAction, currentWeek, dueCardIds, isDue, nextDue, overallFraction, rate, today, weekStats, type Progress, type WeekIndex } from './progress'

const P = (over: Partial<Progress> = {}): Progress => ({ version: 1, updatedAt: '', checks: {}, read: {}, cards: {}, ...over })
const D = '2026-10-25'

describe('rate (spec 8.2)', () => {
  it.each([
    ['didnt, anything', { box: 0 } as const, false, { box: 1, due: '2026-10-26' }],
    ['knew, never rated', undefined, true, { box: 0 }],
    ['knew, box 0', { box: 0 } as const, true, { box: 0 }],
    ['knew, not due yet', { box: 1, due: '2026-10-26' } as const, true, { box: 1, due: '2026-10-26' }],
    ['knew, box 1 due', { box: 1, due: D } as const, true, { box: 2, due: '2026-10-28' }],
    ['knew, box 2 overdue', { box: 2, due: '2026-10-01' } as const, true, { box: 3, due: '2026-11-01' }],
    ['knew, box 3 due', { box: 3, due: D } as const, true, { box: 0 }],
  ])('%s', (_, card, knew, expected) => expect(rate(card, knew, D)).toEqual(expected))
})

describe('local dates', () => {
  it('cross the DST change without drifting', () => {
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
    expect(addDays('2026-10-25', 7)).toBe('2026-11-01')
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
  })
  it('use the local calendar day', () => expect(today(new Date(2026, 9, 25, 0, 30))).toBe(D))
  it('treat due today and overdue as due', () => {
    expect(isDue({ box: 1, due: D }, D)).toBe(true)
    expect(isDue({ box: 2, due: '2026-10-01' }, D)).toBe(true)
    expect(isDue({ box: 1, due: '2026-10-26' }, D)).toBe(false)
    expect(isDue({ box: 0 }, D)).toBe(false)
    expect(isDue(undefined, D)).toBe(false)
  })
})

const week = (n: number, taskIds: string[]): WeekIndex => ({
  n, title: `W${n}`, studyIds: ['s1', 's2'], taskIds, cardIds: ['c1', 'c2'],
  steps: [
    { kind: 'overview', id: 'overview', path: `/week/${n}`, title: 'Overview' },
    { kind: 'reading', id: 'x-1', path: `/week/${n}/x-1`, title: 'One' },
    { kind: 'reading', id: 'x-2', path: `/week/${n}/x-2`, title: 'Two' },
    { kind: 'build', id: 'build', path: `/week/${n}/build`, title: 'Build & Test' },
    { kind: 'quiz', id: 'quiz', path: `/week/${n}/quiz`, title: 'Quiz' },
  ],
})

describe('progress (spec 8.1)', () => {
  const p = P({ checks: { s1: true, t1: true, t2: true }, read: { 'x-1': true }, cards: { c1: { box: 0 } } })
  it('averages step fractions and counts finished steps', () => {
    expect(weekStats(week(0, ['t1', 't2', 't3', 't4']), p)).toEqual({ fraction: 0.5, finished: 1, total: 5, tasksDone: 2, tasksTotal: 4 })
  })
  it('picks the first week with an unticked task, and averages weeks', () => {
    const done = week(0, ['t1', 't2']), open = week(1, ['t3'])
    expect(currentWeek([done, open], p)?.n).toBe(1)
    expect(currentWeek([done], p)).toBeUndefined()
    expect(overallFraction([], p)).toBe(0)
  })
  it('sorts due cards by date and finds the next one', () => {
    const q = P({ cards: { a: { box: 1, due: D }, b: { box: 2, due: '2026-10-20' }, c: { box: 1, due: '2026-10-30' }, d: { box: 0 } } })
    expect(dueCardIds(['a', 'b', 'c', 'd'], q, D)).toEqual(['b', 'a'])
    expect(nextDue(['c', 'd'], q)).toBe('2026-10-30')
  })
})

describe('cardKeyAction', () => {
  const t = (tagName?: string, isContentEditable?: boolean) => ({ tagName, isContentEditable })
  it.each([
    [' ', t('DIV'), false, 'flip'], [' ', t('DIV'), true, 'flip'],
    ['1', t('DIV'), false, null], ['1', t('DIV'), true, 'knew'], ['2', t('BODY'), true, 'didnt'],
    ['1', t('INPUT'), true, null], [' ', t('TEXTAREA'), false, null], [' ', t('SELECT'), false, null],
    [' ', t('DIV', true), false, null], [' ', t('BUTTON'), false, null], ['2', t('BUTTON'), true, 'didnt'],
  ])('%j on %j (flipped %s) → %s', (key, target, flipped, out) => expect(cardKeyAction({ key, target }, flipped)).toBe(out))
  it('ignores modified keys', () => expect(cardKeyAction({ key: '1', ctrlKey: true, target: t('DIV') }, true)).toBeNull())
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/lib/progress.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement everything in the Interfaces block in `src/lib/progress.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress.ts src/lib/progress.test.ts
git commit -m "feat: progress, spaced-repetition and flashcard key rules"
```

---

### Task 4: Storage module

**Files:**
- Create: `src/lib/storage.ts`
- Test: `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `Progress` and `CardState` (types) from `src/lib/progress.ts`.
- Produces (`src/lib/storage.ts`, with no `'use client'` directive, so server files can import `THEME_SCRIPT`):
  - `PROGRESS_KEY = 'backend-study:progress:v1'`, `THEME_KEY = 'backend-study:theme'`
  - `EMPTY_PROGRESS: Progress` = `{ version: 1, updatedAt: '', checks: {}, read: {}, cards: {} }`
  - `parseProgress(text: string): { ok: true; progress: Progress } | { ok: false; error: string }`
    - Keeps unknown ids and drops unknown top-level fields.
    - Errors: `This file isn't valid JSON.`, `This progress file has version <v>; this site reads version 1.`, and `This isn't a progress file from this site.` for any other shape or type problem (a `checks` or `read` value that isn't `true`, a box outside 0–3, box 1–3 without a `YYYY-MM-DD` `due`, or a non-string `updatedAt` or `lastVisited`).
  - `getProgress(): Progress`
    - Cached. The first call reads `PROGRESS_KEY`.
    - Missing or unreadable → `EMPTY_PROGRESS`.
    - Fails `parseProgress` → writes the raw text to `${PROGRESS_KEY}:backup-${new Date().toISOString()}` and uses `EMPTY_PROGRESS`, leaving `PROGRESS_KEY` untouched until the next write.
  - `subscribe(listener: () => void): () => void`: also listens for `storage` events on `PROGRESS_KEY` (when `window` exists) and re-reads.
  - `update(change: (p: Progress) => Progress): void`: stamps `updatedAt` with `new Date().toISOString()`, then caches, writes and notifies. If the write fails, it keeps the in-memory state and sets the failure flag.
  - `replaceProgress(p: Progress): void`: like `update`, but replaces everything.
  - `isSaveFailed(): boolean`, `useSaveFailed(): boolean`
  - `useProgress(): Progress | null`: `useSyncExternalStore(subscribe, getProgress, () => null)`
  - `getTheme(): 'light' | 'dark' | null`, `setTheme(t: 'light' | 'dark' | null): void`: `setTheme` writes or removes `THEME_KEY` and sets or deletes `document.documentElement.dataset.theme`.
  - `THEME_SCRIPT: string`: `try{var t=localStorage.getItem('backend-study:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

- [ ] **Step 1: Write the failing tests.** Each test stubs `localStorage`, then imports the module fresh.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

function stubStorage(init: Record<string, string> = {}, fail: { get?: boolean; set?: boolean } = {}) {
  const map = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => { if (fail.get) throw new Error('blocked'); return map.get(k) ?? null },
    setItem: (k: string, v: string) => { if (fail.set) throw new Error('QuotaExceededError'); map.set(k, v) },
    removeItem: (k: string) => void map.delete(k),
  })
  return map
}
const fresh = async () => { vi.resetModules(); return import('./storage') }
beforeEach(() => vi.unstubAllGlobals())

describe('parseProgress (import validation)', () => {
  it('accepts a valid export and keeps unknown ids', async () => {
    const { parseProgress } = await fresh()
    const text = JSON.stringify({ version: 1, updatedAt: '2026-10-25T10:00:00.000Z', checks: { 'w9:gone': true }, read: {}, cards: { 'x-q1': { box: 1, due: '2026-10-26' } }, extra: 1 })
    expect(parseProgress(text)).toEqual({ ok: true, progress: { version: 1, updatedAt: '2026-10-25T10:00:00.000Z', checks: { 'w9:gone': true }, read: {}, cards: { 'x-q1': { box: 1, due: '2026-10-26' } } } })
  })
  it.each([
    ['not json', "This file isn't valid JSON."],
    [JSON.stringify({ version: 2 }), 'This progress file has version 2; this site reads version 1.'],
    [JSON.stringify([1, 2]), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: { a: 'yes' }, read: {}, cards: {} }), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: {}, read: {}, cards: { c: { box: 5 } } }), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: {}, read: {}, cards: { c: { box: 1 } } }), "This isn't a progress file from this site."],
  ])('rejects %s', async (text, error) => {
    const { parseProgress } = await fresh()
    expect(parseProgress(text)).toEqual({ ok: false, error })
  })
})

describe('reading and writing', () => {
  it('backs up a corrupt stored value instead of losing it', async () => {
    const map = stubStorage({ 'backend-study:progress:v1': '{oops' })
    const { getProgress, EMPTY_PROGRESS } = await fresh()
    expect(getProgress()).toEqual(EMPTY_PROGRESS)
    const backup = [...map.keys()].find(k => k.startsWith('backend-study:progress:v1:backup-'))
    expect(backup && map.get(backup)).toBe('{oops')
    expect(map.get('backend-study:progress:v1')).toBe('{oops')
  })
  it('works without storage: blocked reads give an empty state', async () => {
    stubStorage({}, { get: true })
    const { getProgress, EMPTY_PROGRESS } = await fresh()
    expect(getProgress()).toEqual(EMPTY_PROGRESS)
  })
  it('keeps changes in memory and flags a failed save', async () => {
    stubStorage({}, { set: true })
    const { update, getProgress, isSaveFailed } = await fresh()
    update(p => ({ ...p, checks: { ...p.checks, a: true } }))
    expect(getProgress().checks).toEqual({ a: true })
    expect(isSaveFailed()).toBe(true)
  })
  it('persists with a fresh updatedAt and notifies subscribers', async () => {
    const map = stubStorage()
    const { update, subscribe } = await fresh()
    const seen = vi.fn()
    subscribe(seen)
    update(p => ({ ...p, read: { 'async-1': true } }))
    const saved = JSON.parse(map.get('backend-study:progress:v1')!)
    expect(saved.read).toEqual({ 'async-1': true })
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement everything in the Interfaces block in `src/lib/storage.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: storage module with validation, backup and save-failure flag"
```

---

### Task 5: Content pipeline and static step pages

**Files:**
- Create: `velite.config.ts`, `next.config.mjs`, `src/lib/content.ts`
- Create: `src/app/layout.tsx`, `src/app/globals.css` (a minimal reset for now), `src/app/page.tsx` (for now a plain list of week links)
- Create: `src/app/week/[week]/page.tsx`, `src/app/week/[week]/[step]/page.tsx`

**Interfaces:**
- Consumes: `parsePlan`, `parseNotes`, `resolveNotesRefs` (Tasks 1–2); `StepRef`, `WeekIndex` (Task 3); `THEME_SCRIPT` (Task 4).
- **`velite.config.ts`:**
  - **Loader:** `defineLoader({ test: /\.md$/, load: file => ({ data: basename(file.path) === 'study-plan.md' ? parsePlan(String(file)) : parseNotes(String(file), basename(file.path)) }) })`. It returns no `content`, so a required Markdown field that is accidentally undefined fails loudly instead of rendering the whole file.
  - **Collections:**
    - `plan`: `pattern: 'study-plan.md'`, `single: true`.
    - `notes`: `pattern: '*-notes.md'`.
    - Their schemas mirror `PlanData` and `NotesData` field for field. Every Markdown field is `s.markdown()`, made `.optional()` where the type is optional. `sections` is `s.union([s.array(s.number()), s.literal('all')])`, and `slug` is `s.string().optional()`.
  - **Config:**
    - `root: 'content'`, `strict: true`, `loaders: [loader]`
    - `markdown: { copyLinkedFiles: false, rehypePlugins: [rehypeSlug, [rehypePrettyCode, { theme: { light: 'github-light', dark: 'github-dark' }, keepBackground: true, defaultLang: { block: 'text' } }]] }`
  - **`prepare({ plan, notes })`:**
    - Collect `plan.warnings` (prefixed `study-plan.md: `), each notes file's warnings (prefixed `<file>: `), and `resolveNotesRefs(plan.weeks, notes)`.
    - Print each as `[content] …` with `console.warn`.
    - `throw new Error('study-plan.md: no weeks found')` when `plan.weeks` is empty.
  - After Velite runs, every Markdown field holds **HTML** under the same name.
- **`next.config.mjs`:**
  - Velite's documented top-level-await snippet: when `process.argv` includes `dev` or `build` and `VELITE_STARTED` is unset, set it and run `await (await import('velite')).build({ watch: isDev, clean: !isDev })`.
  - Then export `{ output: 'export', trailingSlash: true, basePath: process.env.NEXT_PUBLIC_BASE_PATH || '' }`.
- **`src/lib/content.ts`** (server only; imports `plan` and `notes` from `#site/content`):
  - **Types:** `type Week = (typeof plan)['weeks'][number]`, `type Notes = (typeof notes)[number]`, `type Card = { id: string; label: string; questionHtml: string; answerHtml?: string }`, `type TocItem = { id: string; title: string; level: 2 | 3 }`.
  - **Lookups:** `weeks: Week[]`, `getWeek(n: number): Week | undefined`, `getNotes(slug: string): Notes | undefined`.
  - **`shortTitle(n: Notes): string`:** the title without `/^Week \d+:\s*/`.
  - **`linkedNotes(week: Week): Notes[]`:** distinct notes in link order.
  - **`stepsOf(week: Week): StepRef[]`:**
    - Overview first: `id 'overview'`, path `/week/<n>`, title `Overview`.
    - Then one reading step per section, in ref order. A ref contributes all sections (`'all'`), the listed numbers, or nothing (`[]`).
      - id `<slug>-<n>`, path `/week/<n>/<slug>-<n>`, title = the section title.
      - `group` = `shortTitle` only when the week's reading steps come from more than one notes file.
      - Duplicate ids keep the first.
    - Then `build` (title `Build & Test`).
    - Then `quiz` (title `Quiz`), only when `quizCards(week)` is non-empty.
  - **`readingSection(week, stepId)`:** returns `{ notes, section }`, or `undefined`.
  - **Quiz cards:**
    - `quizCards(week: Week): Card[]`: cards from linked notes whose *owner week* is this week. The owner week is the highest week number linking that notes file.
    - Card id `<slug>-q<n>`, label `Week <n> · <shortTitle> · Q<n>`.
    - `allCards(): Card[]` in week order.
  - **`applyFor(week: Week): { slug: string; title: string; html: string }[]`:**
    - For each linked notes file: its `applyParts` entry for this week if it has parts, otherwise `apply`.
    - Then any *unlinked* notes file that has a part for this week. This puts the testing notes' Week 6 part on Week 6.
  - **`refTarget(week, ref): { href: string; external: boolean }`:** the first reading step of `ref.slug` in this week, otherwise `/week/<n>/build`. An unresolved ref links to `ref.url` (external).
  - **`weekIndex(week: Week): WeekIndex`**, **`weekIndexes(): WeekIndex[]`**.
  - **`tocOf(html: string): TocItem[]`:** from `<h2|h3 id="…">`, with inner tags stripped and entities decoded.
  - **`inlineHtml(html: string): string`:** removes a single wrapping `<p>…</p>`.
- **Pages:**
  - All dynamic routes export `dynamicParams = false` and `generateStaticParams`. `params` is a `Promise` (Next 16).
  - **Root layout:**
    - Title template `%s · Backend Study Plan`.
    - `<html lang="en" suppressHydrationWarning>`, with `<script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />` in `<head>`.
    - Top bar: site title, plus links `Dashboard` (`/`), `Review` (`/review`), `Capstone` (`/capstone`).
  - **Overview (`/week/[week]`):** kicker `Week <n> · <duration>`, then:
    - `<h1>` title
    - goal
    - "Study notes:" with each ref as a `Link` (or an external `<a>`) followed by its `after` text
    - each linked notes file's intro under an `<h3>` short title
    - `<h2>Study, in order</h2>` as a plain list for now (the `optional` tag rendered as `optional`)
    - each notes file's Sources in `<details><summary>Sources: <short title></summary>`
    - links to the previous and next week
  - **Reading step (`/week/[week]/[step]`):** kicker `Step <i> of <M> · <short title> notes`, `<h1><n>. <title></h1>`, then the body HTML.
  - **Build step:** `<h1>Build & Test</h1>`, then each checklist as `<h2><title></h2>` with a plain list for now. Then each `applyFor` group as `<h2 id="from-<slug>">From the notes: <title></h2>` followed by its HTML.
  - **Quiz step:** `<h1>Quiz</h1>`, `<h2>Self-check</h2>` with `selfCheck` (if any), the owned notes' `quiz.intro`, and "<count> cards" (Task 9 replaces this).
  - **Page titles:**
    - reading: `<n>. <title> · Week <w>`
    - build: `Build & Test · Week <w>`
    - quiz: `Quiz · Week <w>`
    - overview: `Week <w> · <title>`

- [ ] **Step 1: Write `velite.config.ts` and `next.config.mjs`, then build the content**

Run: `npx velite build`
Expected: exit 0. `.velite/` contains `plan.json` and `notes.json`. No `[content]` lines are printed.

- [ ] **Step 2: Write `content.ts` and the pages, then build the site**

Run: `npx next build`
Expected: exit 0 with no type errors.

- [ ] **Step 3: Check the exported pages**

Run:
```bash
find out/week -name index.html | wc -l
grep -c 'data-rehype-pretty-code-figure' out/week/1/async-3/index.html
grep -o 'Diagram not included: event loop cycle · 4 stages' out/week/1/async-2/index.html
test -f out/week/3/testing-6/index.html && test ! -e out/week/4/testing-1 && echo ranges-ok
grep -c 'worker consumes exactly once' out/week/6/build/index.html
```
Expected:
- `134` pages (10 overviews, 104 reading, 10 build, 10 quiz)
- a count ≥ 1 for the code-figure grep
- the diagram line once
- `ranges-ok`
- a count ≥ 1 for the Week 6 grep

- [ ] **Step 4: Commit**

```bash
git add velite.config.ts next.config.mjs src/lib/content.ts src/app tsconfig.json
git commit -m "feat: Velite pipeline and statically generated week steps"
```

---

### Task 6: Docs layout, typography and theme

**Files:**
- Create: `src/components/chrome.tsx` (`'use client'`), `src/components/nav.tsx` (`'use client'`)
- Modify: `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, both week pages

**Interfaces:**
- Consumes: `WeekIndex`, `StepRef` (Task 3); `getTheme`, `setTheme` (Task 4); `TocItem`, `weekIndex`, `weekIndexes` (Task 5).
- Produces:
  - **`DocLayout({ sidebar, toc, children }: { sidebar: ReactNode; toc?: TocItem[]; children: ReactNode })`:**
    - **Columns:** a 3-column grid (`260px minmax(0,1fr) 220px`) from 1100px wide, and 2 columns from 800px. The right column is "On this page" (sticky). Below 1100px the same list renders as `<details>` "On this page" at the top of `<main>`.
    - **Drawer:** below 800px the sidebar becomes an off-canvas drawer opened by a "☰ Menu" button. It closes on route change (`usePathname`), Escape or a backdrop click.
    - **Copy buttons:** after mount, adds a `Copy` button to each `figure[data-rehype-pretty-code-figure] pre` inside `<main>`. It copies `pre.textContent` and shows `Copied` for 1.5s.
  - **`ThemeToggle()`:** a button labelled `Theme: System` / `Theme: Light` / `Theme: Dark` that cycles System → Light → Dark → System through `setTheme`. It shows nothing until mounted.
  - **`WeekSidebar({ week }: { week: WeekIndex })`:** the week title, then steps as links (`n · title` for reading steps), with a small group label each time `step.group` changes. The current step gets `aria-current="page"`.
  - **`WeeksNav({ weeks }: { weeks: WeekIndex[] })`:** `Week n · title` links, then a "More" group with `Capstone`, `Review` and `Export / import` (`/progress`).
- **CSS (`globals.css`):**
  - **Colour:** `:root { color-scheme: light dark }`, with `[data-theme=light]` and `[data-theme=dark]` overriding `color-scheme`. All colours are tokens defined with `light-dark()`.
  - **Code:** `pre { background: light-dark(var(--shiki-light-bg), var(--shiki-dark-bg)) }` and `pre span { color: light-dark(var(--shiki-light), var(--shiki-dark)) }`.
  - **Reading column:** `.prose { font-size: 1.0625rem; line-height: 1.6; max-width: 75ch }`, with `.prose table { display: block; overflow-x: auto }` and `pre { overflow-x: auto }`.
  - **Lost diagrams:** `.diagram-missing` is muted text in a dashed box.
  - Visual polish beyond this is left to the builder (spec section 13).

- [ ] **Step 1: Implement the components and CSS, and wrap every page in `DocLayout`.** Week pages get `WeekSidebar` (reading steps also get `tocOf(body)`; the build step gets the `from-<slug>` groups plus their `tocOf`). Other pages get `WeeksNav`. Put `ThemeToggle` in the top bar.

- [ ] **Step 2: Check in the browser**

Run: `npm run dev`, then open http://localhost:3000/week/2/rest-3/.
Expected:
- **1280px wide:** three columns, a sticky "On this page" and highlighted code.
- **375px wide** (`resize_window` mobile): the drawer opens and closes, and `document.documentElement.scrollWidth === innerWidth` in the console, even with this page's wide tables.
- **Theme:** the toggle switches light and dark (code colours included). After a reload the theme holds with no flash.
- **Copy:** the button puts the code on the clipboard.

- [ ] **Step 3: Build**

Run: `npx next build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components src/app
git commit -m "feat: docs layout with drawer, on-this-page list and theme toggle"
```

---

### Task 7: Saved progress on week pages

**Files:**
- Create: `src/components/progress-widgets.tsx` (`'use client'`)
- Modify: `src/components/nav.tsx`, `src/app/layout.tsx`, both week pages

**Interfaces:**
- Consumes: `useProgress`, `update`, `useSaveFailed` (Task 4); `weekStats`, `stepFraction`, `dueCardIds`, `today` (Task 3).
- Produces (`progress-widgets.tsx`):
  - **`ProgressBar({ fraction }: { fraction: number | null })`:** `null` renders an empty neutral track with no number. It never shows a fake 0%.
  - **`Checklist({ items }: { items: { id: string; html: string; label?: string; optional?: boolean }[] })`:**
    - A labelled checkbox per item, bound to `checks[id]`.
    - Pages pass `html` already unwrapped with `inlineHtml` on the server, because client code can't import it from `content.ts`.
    - The bold `label` sits before the text, and an `optional` tag follows when `optional`.
    - Checkboxes are disabled until progress loads.
  - **`StepFooter({ week, stepId, after }: { week: WeekIndex; stepId: string; after?: { path: string; title: string } })`:**
    - Has `data-pagefind-ignore`.
    - Previous step link: `← <title>`.
    - Reading step:
      - unread: button `Mark as read · Next →` (sets `read[id]`, then `router.push(next)`);
      - read: link `Next →` plus button `Mark as unread`.
    - Other steps: link `Next →`.
    - On the last step, `after` is the next week's Overview, or `{ path: '/capstone', title: 'Capstone' }` after Week 9.
  - **`TrackVisit({ path }: { path: string })`:** on mount, `update(p => ({ ...p, lastVisited: path }))`. Renders nothing.
  - **`ReviewBadge({ cardIds }: { cardIds: string[] })`:** the due count next to "Review". Hidden when 0 or before load.
  - **`SaveWarning()`:** `role="status"` with the text `Progress can't be saved in this browser.` when `useSaveFailed()`.
  - **Sidebar changes:** `WeekSidebar` gains `ProgressBar`, `<finished> of <total> steps` (after load only) and a ✓ on finished steps. `WeeksNav` gains a ✓ on weeks at fraction 1.

- [ ] **Step 1: Implement the widgets and wire them in**
  - Overview: `Checklist` for the study items, plus `StepFooter`.
  - Build step: `Checklist` per list, plus `StepFooter`.
  - Reading and quiz steps: `StepFooter`.
  - Every step: `TrackVisit` with the step's path.
  - Root layout: `ReviewBadge` (with `allCards().map(c => c.id)`) and `SaveWarning`.

- [ ] **Step 2: Check in the browser** (`npm run dev`)
  - On `/week/1/`, tick "Day 1" and reload. It stays ticked.
  - On `/week/1/async-1/`, click `Mark as read · Next →`. You land on `async-2`, section 1 has a ✓ in the sidebar, and the bar moved.
  - With two tabs open, a tick in one shows in the other.
  - The console has no hydration warnings.
  - `curl -s http://localhost:3000/week/1/ | grep -c 'of 11 steps'` prints `0`, so numbers appear only after load.
  - In the console, run `Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError') }`. A tick still shows, and `Progress can't be saved in this browser.` appears.

- [ ] **Step 3: Build and test**

Run: `npm test && npx next build`
Expected: PASS and exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components src/app
git commit -m "feat: saved checklists, mark-as-read and sidebar progress"
```

---

### Task 8: Dashboard, Capstone and Export/Import

**Files:**
- Create: `src/components/Dashboard.tsx` (`'use client'`), `src/components/ProgressIO.tsx` (`'use client'`), `src/app/capstone/page.tsx`, `src/app/progress/page.tsx`
- Modify: `src/app/page.tsx`, `src/components/progress-widgets.tsx`

**Interfaces:**
- Consumes: `weekStats`, `overallFraction`, `currentWeek`, `dueCardIds`, `today` (Task 3); `useProgress`, `getProgress`, `parseProgress`, `replaceProgress` (Task 4); `ProgressBar`, `Checklist` (Task 7).
- Produces:
  - **`Dashboard({ weeks, cardIds, aboutHtml }: { weeks: WeekIndex[]; cardIds: string[]; aboutHtml?: string })`.** All numbers wait for progress to load (placeholders until then). It shows:
    - `Overall progress · <p>%` plus a bar.
    - **Current week card:**
      - kicker `Current week`
      - `Week <n> · <title>`
      - a bar
      - `<finished> of <total> steps · Build & Test <done> of <total>`
      - a link `Continue: <step title>`. It goes to `lastVisited` when that path is one of the steps, otherwise to `/week/0`, labelled `Start: Week 0 · <title>`.
    - When there is no current week, the card instead reads `Plan complete` with a link to Capstone.
    - **Review card:** `<n> cards due` (or `Nothing due`), plus a `Start review` link.
    - **Week grid:** 10 cards with `Week <n> · <duration>`, the title, a bar, and `✓ Done` or `<p>%`. The current week is highlighted.
    - **About:** `<details><summary>About this plan</summary>` containing `aboutHtml`.
  - **`CapstoneWeeks({ weeks }: { weeks: WeekIndex[] })`** (in `progress-widgets.tsx`): one row per week, linking to `/week/<n>/build/` with the text `Week <n> · <title>` and `<done> / <total>`.
  - **`ProgressIO()`:**
    - An `Export progress` button downloads `backend-study-progress-<today()>.json`, containing `JSON.stringify(getProgress(), null, 2)`.
    - An `Import progress` file input (`accept=".json,application/json"`):
      - Runs `parseProgress`; an error shows in `role="alert"`.
      - Otherwise asks `confirm('Replace the progress on this device with this file (saved <updatedAt as a local date and time>)? This can't be undone.')`, then `replaceProgress` and shows `Progress imported.`
- **Pages:**
  - `/` renders `DocLayout` + `WeeksNav`, then `<h1>` with the plan title, then `Dashboard` (`aboutHtml = plan.intro`).
  - `/capstone`: `<h1>Capstone</h1>`, the capstone intro, `Checklist` of the capstone items, then `<h2>Build & Test by week</h2>` with `CapstoneWeeks`.
  - `/progress`: `<h1>Export / import progress</h1>` with `ProgressIO`.

- [ ] **Step 1: Implement the components and pages**

- [ ] **Step 2: Check in the browser** (`npm run dev`)
  - The dashboard numbers match the ticks made in Task 7, and Continue opens the last step visited.
  - Ticking every Week 0 Build and Test box moves "Current week" to Week 1.
  - Export → clear site data → import that file → confirm. Everything returns.
  - Importing a `.json` that contains `{"version": 2}` shows `This progress file has version 2; this site reads version 1.` and changes nothing.

- [ ] **Step 3: Build and test**

Run: `npm test && npx next build`
Expected: PASS and exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components src/app
git commit -m "feat: dashboard, capstone page and progress export/import"
```

---

### Task 9: Quiz and Review

**Files:**
- Create: `src/components/Flashcards.tsx` (`'use client'`), `src/app/review/page.tsx`
- Modify: `src/app/week/[week]/[step]/page.tsx` (quiz step)

**Interfaces:**
- Consumes: `rate`, `isDue`, `dueCardIds`, `nextDue`, `today`, `cardKeyAction` (Task 3); `useProgress`, `update` (Task 4); `type Card` from `content.ts` (type-only import).
- Produces: `Flashcards({ cards, mode, weekPath }: { cards: Card[]; mode: 'quiz' | 'review'; weekPath?: string })`. Behaviour, from spec 7.2 item 4 and 7.4:
  - **Before progress loads:** a placeholder.
  - **Quiz, first pass** (some cards unrated):
    - The deck is the unrated cards in order.
    - Header: `Card <k> of <N> · knew <x> · didn't <y>`, where k = rated + 1, x = cards in box 0 and y = rated − x, all rebuilt from saved state.
  - **The card:**
    - Before the flip: the question HTML and a button `Show answer` showing a `Space` key hint.
    - After the flip: the answer below a divider (or `No answer in the notes`), then `Knew it` (hint `1`) and `Didn't know` (hint `2`).
    - Rating runs `update(p => ({ ...p, cards: { ...p.cards, [id]: rate(p.cards[id], knew, today()) } }))`, advances, and moves focus to the card container (`tabIndex={-1}`).
  - **End of any run:**
    - `<known> of <N> known`
    - the missed questions, each in `<details>` with its answer
    - `Go through the <m> again now` (only when m > 0)
    - `Back to the week` (a link to `weekPath`)
  - **Every card rated when the quiz opens:**
    - `<known> known · <inReview> in review`
    - the questions in box 1–3, each in `<details>` with its answer
    - a `Start over` button
    - "Start over" and practice runs are in memory only.
  - **Review:**
    - The deck = `dueCardIds(all ids, p, today())`, snapshotted when the run starts. Header `Card <k> of <N>`.
    - At the end: `Reviewed <N> · knew <x>`.
    - When the deck is empty: `Nothing due. Next card comes back on <date>.` using `nextDue`, formatted with `toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })`. With no review cards at all: `No cards are scheduled for review.`
  - **Keys:** a `keydown` listener on `window` uses `cardKeyAction(e, flipped)`. It calls `preventDefault()` for every action it handles, so Space never scrolls.
- **Pages:**
  - The quiz step renders `<Flashcards cards={quizCards(week)} mode="quiz" weekPath={`/week/${n}`} />` below the Self-check and intro from Task 5.
  - `/review`: `<h1>Review</h1>` and `<Flashcards cards={allCards()} mode="review" />` inside `DocLayout` + `WeeksNav`.

- [ ] **Step 1: Implement `Flashcards` and wire both pages**

- [ ] **Step 2: Check in the browser** (`npm run dev`, on `/week/1/quiz/`)
  - Space flips back and forth without scrolling the page. Before the flip, 1 does nothing. After the flip, 1 and 2 rate.
  - Rate Q1 "didn't" and Q2 "knew", then reload. The quiz resumes at card 3 of 12 with `knew 1 · didn't 1`.
  - In the console, run `document.body.prepend(document.createElement('input'))`. Click into that input and type `1 2` and spaces. Nothing happens to the card and the page doesn't scroll.
  - Finish the quiz. The end screen lists the misses and the practice round works. After a reload it shows `<known> known · <inReview> in review` with `Start over`.
  - In the console, change one card's `due` in `backend-study:progress:v1` to today, then reload `/review/`. That card is due, and the badge shows 1.

- [ ] **Step 3: Build and test**

Run: `npm test && npx next build`
Expected: PASS and exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components src/app
git commit -m "feat: end-of-week flashcard quiz and review page"
```

---

### Task 10: Search

**Files:**
- Modify: `src/components/chrome.tsx` (add `Search`), `src/app/layout.tsx`, both week pages

**Interfaces:**
- Produces: `Search()`, a top-bar button `Search` that opens a panel. The `/` key opens it too, unless you're typing.
  - **Loading:** on first open it loads `${base}/pagefind/pagefind-ui.css` and `${base}/pagefind/pagefind-ui.js`, where `base = process.env.NEXT_PUBLIC_BASE_PATH ?? ''`. Then it mounts `new window.PagefindUI({ element: '#search-panel', showSubResults: true, showImages: false, baseUrl: `${base}/`, autofocus: true })`.
  - **Dev mode:** if the script fails to load, it shows `Search works in the built site: run npm run build, then npm run preview.`
  - **Closing:** Escape, an outside click or a route change closes it.
  - **Styling:** its colours come from the theme tokens through Pagefind's `--pagefind-ui-*` variables.
- **Indexing:** add `data-pagefind-body` to the `<article>` of the Overview, reading and Build & Test steps only. The quiz, dashboard, review, capstone and progress pages are not indexed.

- [ ] **Step 1: Implement `Search` and the indexing attributes**

- [ ] **Step 2: Build and preview**

Run: `npm run build && npm run preview`
Expected: Pagefind reports `124` pages indexed. The site serves on http://localhost:1414.

- [ ] **Step 3: Check search** at http://localhost:1414
  - `TaskGroup` returns "Running things concurrently" with sub-results that open the step at the heading.
  - `keep running unsupervised` (it appears only in an answer) returns nothing.
  - On `/week/1/quiz/`, open search and type `1 2` and spaces in it. The card doesn't flip or get rated.

- [ ] **Step 4: Commit**

```bash
git add src/components src/app
git commit -m "feat: Pagefind search over overview, reading and build pages"
```

---

### Task 11: GitHub Pages workflow and README

**Files:**
- Create: `.github/workflows/deploy.yml`, `README.md`

**Interfaces:**
- **`deploy.yml`:**
  - Triggers: `push` to `main` and `workflow_dispatch`.
  - `permissions: { contents: read, pages: write, id-token: write }`, and `concurrency: { group: pages, cancel-in-progress: false }`.
  - **`build` job:**
    1. `actions/checkout@v7`
    2. `actions/setup-node@v7` (`node-version: 24`, `cache: npm`)
    3. `actions/configure-pages@v6` with `id: pages`
    4. `npm ci`
    5. `npm test`
    6. `npm run build`, with env `NEXT_PUBLIC_BASE_PATH: ${{ steps.pages.outputs.base_path }}`
    7. `actions/upload-pages-artifact@v5` with `path: out`
  - **`deploy` job:** `needs: build`, `environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }`, and `actions/deploy-pages@v5` with `id: deployment`.
- **`README.md`:**
  1. What the site is.
  2. Run locally: `npm install`, `npm run dev`, `npm test`, `npm run build`, `npm run preview`. Search works only in preview.
  3. Add or update content:
     - the plan conventions (spec 6.1) and notes conventions (spec 6.2) the parser relies on;
     - `sections X–Y` / `the Week N part of …` qualifiers and `### Week N:` Apply parts;
     - what progress is attached to (rewording a task resets its tick; renumbering sections moves read marks and cards);
     - where warnings appear (`[content]` lines in the build log).
  4. Deploy: create the GitHub repo, push `main`, then Settings → Pages → Source: **GitHub Actions**. The base path is automatic, and the site is public.

- [ ] **Step 1: Write both files**

- [ ] **Step 2: Check a base-path build.** Set `SCRATCH` to a directory outside the repo (Task 12 reuses it).

Run:
```bash
NEXT_PUBLIC_BASE_PATH=/study npm run build
grep -c '/study/_next/' out/index.html
grep -c 'href="/study/week/0/"' out/index.html
rm -rf "$SCRATCH/site" && mkdir -p "$SCRATCH/site" && cp -R out "$SCRATCH/site/study"
python3 -m http.server 8123 -d "$SCRATCH/site"
```
Expected: both counts are ≥ 1. At http://localhost:8123/study/, navigation, theme, a tick and search all work, and result links start with `/study/`.

- [ ] **Step 3: Rebuild without a base path**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github README.md
git commit -m "docs: README and GitHub Pages deploy workflow"
```

---

### Task 12: Final check and report

- [ ] **Step 1: Run everything**

Run: `npm test && npm run build 2>&1 | tee "$SCRATCH/build.log"`
Expected:
- all tests pass
- the build exits 0 with no type errors
- `grep -c '\[content\]' "$SCRATCH/build.log"` prints `0`

- [ ] **Step 2: Start the dev server.** Add `.claude/launch.json` with `{ "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }` and start it with `preview_start`. Then click through the dashboard, current week, a reading step, Build & Test, Quiz and Review, in both themes and at 375px wide.

- [ ] **Step 3: Report to the user** a short list of what didn't parse cleanly:
  - Any `[content]` warnings (expected: none).
  - The 20 lost diagrams, by file. Get them with `grep -c 'embedded content' content/*-notes.md`.
  - Content adaptations: Week 8's combined list, Week 9 without a Test list, the two short "Testing" links matched by URL, and the testing notes' Week 6 part shown on Week 6.
