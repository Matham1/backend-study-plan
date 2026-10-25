# Study site: design

Date: 2026-10-25 · Status: draft, waiting for your approval

Items marked **(my call)** were decided by me, not by you. Everything else comes from your original request or from our conversation.

## 1. What this is and why

This is a static website that turns the Markdown in `./content` into a guided course. The content is a 10-week backend Python study plan (Weeks 0–9) plus 12 notes files. Each week becomes a short sequence of pages you click through. Progress is saved in the browser, and each week ends with a flashcard quiz.

In your words: *"Easy to read material divided by step by step pages with progress for each week. Quizzes at the end of each week."*

The notes are written for interview practice: "answer out loud, as in an interview, before reading the answers". So the quiz uses self-graded flashcards, and cards you miss come back on a simple 1/3/7-day schedule.

It's a personal tool for one learner, with no accounts and no server. Progress lives in the browser and moves between devices as a JSON file.

## 2. Goals

- Make the material easy to read: comfortable type, short lines, readable code and tables, on a laptop and a phone.
- Split every week into step pages: **Overview → the notes, one section per page → Build & Test → Quiz**.
- Show progress for each week and overall, point to the current week, and offer one-click "continue where you left off".
- Put a flashcard quiz at the end of each week, plus a single Review page that brings back missed cards on a 1/3/7-day schedule.
- Add a Capstone page, full-text search, and progress export/import.
- Keep content edits free of code changes: you change the Markdown and rebuild.

## 3. Non-goals

- Accounts, sync servers, analytics or comments. Progress moves between devices only through export/import.
- Typed answers or automatic grading. You grade yourself.
- Editing content in the browser.
- A single long page per notes file. The step pages replace it.
- Making the notes' own `- [ ]` checkboxes interactive (see 6.3).
- Restoring the 20 diagrams that were lost in the export. A note marks each spot instead (see 6.2). Pulling them from the original claude.ai docs could be a follow-up.
- Searching quiz answers, so search can't spoil the quiz **(my call)**.

## 4. Anti-goals (failures even if everything "works")

- **Reading is uncomfortable:** small text, long lines, code blocks that are hard to scan, or tables that break the layout on a phone.
- **Progress is lost or lands on the wrong item.** Examples: an import that overwrites progress without asking, corrupt stored data that silently gets replaced, or ticks that move to a different task after a task is inserted into the plan.
- **Progress flickers or shows a fake 0%** before the browser state loads, or hydration errors appear in the console.
- **A content edit needs a code change.** Adding a task, a week or a notes file should just work.
- **A content inconsistency crashes the build.** It should produce a warning with the file name.

## 5. Constraints (from you)

- Next.js App Router + TypeScript with `output: 'export'`, so the site is fully static.
- Content is loaded with **Velite**, not Contentlayer. Code is highlighted with **rehype-pretty-code** (Shiki).
- Interactive parts (checklists, flashcards, progress) are client components. They read localStorage only after mount, through `useSyncExternalStore` or `useEffect`.
- All storage goes through **one small module** that wraps every call in try/catch.
- **Pagefind** runs on the exported `out/` folder after the build.
- **Vitest** unit tests cover the parsing module: week extraction, checklist extraction, and Q&A pairing. A mismatch between question and answer counts must produce a warning, not a crash.
- `next build` passes with no type errors.
- A GitHub Actions workflow builds the site and deploys it to GitHub Pages.
- The README explains how to add or update content, run the site locally, and deploy.
- Design: clean documentation style. Light and dark themes follow the system setting, plus a toggle. Body text is about 17px with lines of at most about 75 characters. On mobile the sidebar becomes a drawer. Flashcard keys: Space flips, 1 = knew it, 2 = didn't.
- The files in `./content` stay as they are, and the parser adapts to them.

## 6. The content, as it actually is

I read all 13 files. The parser must handle what's really there:

### 6.1 `study-plan.md`

- **Header:** the title (`# Backend Study Plan (Python)`) and a byline, followed by `## How to use this plan`, which includes "The capstone" and "Background book".
- **Weeks:** each starts with a heading like `## Week 1 — Async Python (5 days)`, using an em dash and putting the duration in brackets. Inside a week there are:
  - `**Goal:** …` (one paragraph)
  - `**Study notes:** …`: links to the notes, sometimes with qualifiers (see below)
  - `**Study, in order**` followed by a numbered list. Most items start with a bold label (`**Day 1:**`, `**Days 1–2:**`, `**Throughout:**`, `**Optional, to go deeper:**`).
  - `**Build**` and `**Test**`, each followed by a `- [ ]` list
  - sometimes `**Self-check:** …` (one paragraph of external links)
- **Exceptions:** Week 8 has a single combined `**Build + Test**` list. Week 9 has no Test list. Self-check appears only in Weeks 2, 3 and 6.
- **Study notes links** point to claude.ai artifact URLs, not the local files. 13 of the 15 links use the notes title as their text. Two just say "Testing" and share the same URL as the full-title testing link.
- **Qualifiers after a notes link** (en dashes): "sections 1–5", "sections 6–7", "sections 8–10 and the Week 8 part of 'Apply it to the capstone'", "the Week 4 part of 'Apply it to the capstone'", "(days 1–3)", "(days 4–5)".
- **Ending:** the file ends with `## Final capstone checklist`, an intro sentence and 8 `- [ ]` items.

### 6.2 The 12 notes files (`<n>-<topic>-notes.md`)

- **Opening:** `# Study Notes — Week N: Topic`, a byline, then one intro paragraph. The testing notes are the exception: `# Study Notes — Testing: Unit, Integration and CI` has no week number. Its file is `8-testing-notes.md`, but Weeks 2, 3, 4 and 8 all use it.
- **Concept sections:** 6 to 10 numbered sections (`## 1. …`), with `###` subsections.
- **Fixed closing sections:** `## Apply it to the capstone`, `## Check yourself`, `## Answers`, `## Sources`, in that order.
- **Apply sections:** their `###` headings vary ("Task 1: …", "1. …", "Step 1: …", "Tests", "Definition of done", "Done when"). In the testing notes, the Apply section is split into `### Week 2: …`, `### Week 3: …`, `### Week 4: …`, `### Week 6: …` and `### Week 8: …`.
- **Check yourself and Answers:** every file has exactly 12 numbered questions and 12 numbered answers, one line each, so they pair cleanly. Around the questions, Check yourself has extra paragraphs: an intro line in 8 files, and a closing "For more practice…" paragraph in the event-driven notes.
- **Code inside fences:** code blocks contain lines starting with `#` (Python comments). These must never be read as headings. Languages used: python, sql, yaml, bash, toml, http, json, lua, dockerfile, text, and some unlabelled blocks.
- **Lost diagrams:** 20 lines like `&#91;embedded content: event loop cycle · 4 stages\]` mark diagrams that didn't survive the export. Each one is rendered as a small grey note: "Diagram not included: event loop cycle · 4 stages".
- **Markdown details:**
  - Many GFM tables, some of them wide.
  - One blockquote and one nested ordered list.
  - Escapes left over from the export (`\~`, `\_`, `&#91;`). These are standard Markdown and render correctly.
  - Headings repeat a lot ("Pitfalls" appears in most sections), so heading ids must be de-duplicated.

### 6.3 Checkboxes inside the notes

The Apply sections contain 66 `- [ ]` items, for example under "Definition of done". They are worded differently from the plan's Build and Test lists. They render as plain bullets without a checkbox, so the plan's Build and Test boxes are the only ones that count.

## 7. The experience (decided with you)

### 7.1 Layout: "docs style" (option A from the mockups)

- **Top bar:** site title, links to Dashboard, Review (with a due count) and Capstone, a search box, and the theme toggle.
- **Left sidebar** on week pages: the week's name, a progress bar, "N of M steps", and the list of steps. Each step shows a tick when it's finished, and the current step is highlighted. On other pages the sidebar lists the 10 weeks plus Capstone, Review and Export/import.
- **Right column:** an "On this page" list of the step's subheadings that stays in view while you scroll.
- **Mobile:** the left sidebar becomes a drawer opened from a menu button. The "On this page" list collapses into a block at the top of the content.
- **Reading column:** about 17px text, line-height around 1.6, at most about 75 characters per line. Code blocks have a Copy button. Wide tables scroll sideways inside their own box, so the page itself never scrolls sideways.

### 7.2 A week = a sequence of steps

Example: Week 1 has 11 steps: Overview, eight reading steps (Async notes sections 1–8), Build & Test, and Quiz.

1. **Overview** (`/week/N`)
   - Week title, duration and goal.
   - The plan's Study notes line, with its links rewritten to point at this site's step pages.
   - For each notes file in the week: its intro paragraph ("After this week you will…").
   - "Study, in order" with a checkbox on each item. Optional items get an "optional" tag.
   - Each notes file's Sources, in a collapsed block **(my call)**.
   - Links to the previous and next week.
2. **Reading steps** (`/week/N/<notes>-<section>`, for example `/week/1/async-3`)
   - **Which sections:** one page per numbered notes section, ordered by how the links appear on the plan's Study notes line. A link with a "sections X–Y" qualifier contributes only those sections. A link with no section qualifier contributes all numbered sections, and "(days …)" qualifiers are only shown as text. "The Week N part of 'Apply it to the capstone'" contributes no reading steps (see Build & Test).
   - **What the page shows:**
     - The heading becomes the page title, and a line above it reads "Step 4 of 11 · Async Python notes".
     - At the bottom: "← previous step" and **"Mark as read · Next →"**. Once a page is marked read, the button becomes "Next →", with a small "Mark as unread" link next to it.
   - **What this gives each week:** Week 2 reads REST sections 1–9 then testing 1–5. Week 3 reads indexes 1–9, transactions 1–9, then testing 6–7 (20 reading pages). Week 4 reads Redis 1–9 only. Week 8 reads testing 8–10.
3. **Build & Test** (`/week/N/build`)
   - The week's checklists (Build, Test, or Build + Test), with each box saved.
   - Below them, "From the notes": each linked notes file's "Apply it to the capstone" section.
   - Where an Apply section is split into `### Week N: …` parts, only this week's part is shown. That part also appears on Week N even when the plan doesn't link those notes for that week, which puts the testing notes' Week 6 part on Week 6 **(my call)**.
4. **Quiz** (`/week/N/quiz`)
   - **Which cards:** flashcards from the week's notes. A notes file's quiz belongs to the *last* week that links to it, so the testing notes' 12 cards go in Week 8. Weeks 3 and 6 have 24 cards; every other week has 12.
   - **Above the cards:** the week's Self-check paragraph (Weeks 2, 3 and 6), followed by the extra paragraphs from Check yourself.
   - **One card:** the question shows first. Space or a click flips it to show the written answer underneath. Then press 1 for "Knew it" or 2 for "Didn't know", and the next card appears. The 1 and 2 keys work only after the card is flipped **(my call)**. Shortcuts don't fire while you're typing in the search box.
   - **During the quiz:** a "Card 4 of 12 · knew 3 · didn't 0" line.
   - **At the end:** the score ("9 of 12 known") and the missed questions, each with its answer one click away. A "Go through the 3 again now" button runs a practice round of only the missed cards, and a "Back to the week" button returns to the week. The practice round was my addition and you accepted it.
   - **Resuming:** ratings are saved as you go. If you leave during your first pass, the quiz resumes at the first card you haven't rated, and its counters are rebuilt from the saved card states, so nothing extra is stored.
   - **After the first pass** **(my call)**: the quiz opens on where the week's cards stand now ("9 known · 3 in review"). It lists the in-review questions, each with its answer one click away, and offers "Start over".
   - **"Start over" and the practice round** run in memory only, and leaving the page ends them. Their ratings still follow rule 8.2, so they never clear saved card states or schedules **(my call)**.

### 7.3 Dashboard (`/`)

- Overall progress bar.
- **Current week** card: title, progress bar, "N of M steps · Build & Test x of y", and a **Continue** button. The button opens the last step page you opened, or Week 0's Overview on your first visit.
- **Review** card: how many cards are due, with a "Start review" button.
- A grid of 10 week cards: week number, duration, title, a progress bar, and the % or "✓ Done".
- A collapsed "About this plan" block with the plan's intro **(my call)**.

### 7.4 Review (`/review`)

- All cards due today or earlier, from every week, in one pile. They're sorted by due date, then week order, using the same card controls as the quiz.
- When nothing is due: "Nothing due. Next card comes back on <date>." If no cards are scheduled at all, it says so.

### 7.5 Capstone (`/capstone`)

- The plan's final checklist (8 items, saved like the other checklists).
- A list of the 10 weeks, each with a link to its Build & Test step and its "ticked / total" count.

### 7.6 Search

- Pagefind indexes only the main content of the Overview, reading and Build & Test pages. Quiz cards, the sidebar and navigation are excluded.
- The search box sits in the top bar. Each result opens the matching step page, at the right heading where possible.

### 7.7 Export / import (`/progress`)

- **Export** downloads `backend-study-progress-YYYY-MM-DD.json`.
- **Import** checks the chosen file first (version and field types). It then asks: "Replace the progress on this device with this file (saved <date>)? This can't be undone." Only after you confirm does it replace everything. A bad file shows an error and changes nothing. Ids the current content doesn't use are kept and ignored, so an older export still imports.

### 7.8 Theme

- On first visit the site follows the system setting. The toggle switches between light and dark and remembers your choice, and it can go back to following the system.
- A tiny script in `<head>` applies the saved theme before the first paint, so there's no flash of the wrong theme.
- Code colours switch with the theme: dual Shiki themes through rehype-pretty-code's CSS variables.

## 8. Rules to implement exactly

### 8.1 When a step is finished, and how much it counts

| Step | Finished when | Fraction used for % |
|---|---|---|
| Overview | every non-optional study item is ticked | ticked ÷ non-optional items |
| Reading | marked read | 0 or 1 |
| Build & Test | every item in the week's checklists is ticked | ticked ÷ items |
| Quiz | every card of the week has been rated at least once | rated ÷ cards |

- **Week %** is the average of its steps' fractions, so every tick moves the bar. "N of M steps" counts only finished steps **(my call)**.
- **Overall %** is the average of the 10 week percentages, because each week is a week of time **(my call)**.
- **Current week** is the lowest-numbered week that still has an unticked Build/Test item. This follows the plan's own rule, "a week is done when every Build and Test box is ticked". When there is none, the dashboard says the plan is complete and links to Capstone.
- **Progress widgets** show a neutral placeholder until the browser state has been read. They never show a fake 0%.

### 8.2 Spaced repetition (1, 3, 7 days)

Dates are local calendar days (`YYYY-MM-DD`). A card is **due** when it is in box 1–3 and its due date is today or earlier.

| Rating | Card before | Card after |
|---|---|---|
| Didn't know | anything | box 1, due tomorrow |
| Knew it | never rated | box 0 (known, never comes back) |
| Knew it | box 0 | unchanged |
| Knew it | box 1–3, not due yet | unchanged: practice doesn't move the schedule |
| Knew it | box 1, due | box 2, due in 3 days |
| Knew it | box 2, due | box 3, due in 7 days |
| Knew it | box 3, due | box 0 |

The same rule applies everywhere: in the week's quiz, on the Review page and in the practice round.

### 8.3 Stable ids (what progress is attached to)

- **Checkboxes:** the id is built from the item's text, not its position. Plan checklists are the content most likely to be edited, and inserting a task must not shift other ticks.
  - Format: `w<N>:<slug>` for study items and Build/Test items in week N, and `capstone:<slug>` for the final list.
  - The slug is the item's plain text, lowercased, with runs of other characters replaced by `-`, and cut to 60 characters. A repeated slug within the same scope gets `-2`, `-3`.
  - Example: `w3:seed-script-about-50k-events-and-1m-bookings`.
  - Rewording an item resets its tick. The README must say so.
- **Reading steps:** `<notes>-<section number>`, for example `async-3`. The author already numbers the sections. Renumbering them moves the read marks, and the README says so.
- **Cards:** `<notes>-q<question number>`, for example `async-q4`.
- **Notes slug:** the file name minus the number prefix and `-notes.md`, with `_` turned into `-`. So `1-async-notes.md` becomes `async`, and `3-psql_indexes-notes.md` becomes `psql-indexes`.

## 9. Data model

### 9.1 Content (built at build time)

```ts
type Plan = {
  title: string                      // "Backend Study Plan (Python)"
  introHtml: string                  // "How to use this plan" etc.
  weeks: Week[]
  capstone: { introHtml: string; items: Task[] }
}

type Week = {
  n: number                          // from "## Week N — …"
  title: string                      // "Async Python"
  duration?: string                  // "5 days"
  goalHtml: string
  studyNotesHtml: string             // links rewritten to step pages
  notesRefs: { notes: string; sections: number[] }[]  // reading order for the week
  study: { id: string; label?: string; html: string; optional: boolean }[]
  checklists: { title: string; items: Task[] }[]      // "Build" / "Test" / "Build + Test", in file order
  selfCheckHtml?: string
}

type Task = { id: string; html: string }

type Notes = {
  slug: string                       // "async"
  title: string                      // "Week 1: Async Python"
  introHtml: string
  sections: { n: number; id: string; title: string; html: string; toc: { id: string; title: string }[] }[]
  apply: { html: string; weekParts: Record<number, string> }  // weekParts: "### Week N: …" split out
  quiz: { introHtml: string; cards: { id: string; n: number; questionHtml: string; answerHtml: string | null }[] }
  sourcesHtml: string
}
```

Pages don't read these directly. One content module joins them into weeks → steps (`overview | reading | build | quiz`), each step with its path, title, and previous/next links.

### 9.2 Browser storage (localStorage)

GitHub Pages serves every project site of an account from the same origin (`<user>.github.io`), which means they all share one localStorage. So every key starts with `backend-study:`.

| Key | Value |
|---|---|
| `backend-study:progress:v1` | the `Progress` JSON below |
| `backend-study:theme` | `"light"` or `"dark"`; absent means follow the system |
| `backend-study:progress:v1:backup-<ISO time>` | the raw text of a stored value that failed to parse, saved before anything replaces it |

```ts
type Progress = {
  version: 1
  updatedAt: string                  // ISO time of the last change; shown on export/import
  checks: Record<string, true>       // ticked boxes: study, Build/Test, capstone (absent = unticked)
  read: Record<string, true>         // reading steps marked read, by section id
  cards: Record<string, CardState>   // by card id; absent = never rated
  lastVisited?: string               // path of the last step page opened, e.g. "/week/3/psql-indexes-6"
}

type CardState =
  | { box: 0 }                        // known
  | { box: 1 | 2 | 3; due: string }   // in review; due = "YYYY-MM-DD"
```

**The storage module** is the only code that touches localStorage. It:
- reads and parses once, then caches;
- returns an "unknown yet" snapshot on the server and before mount;
- writes with try/catch, so a full or blocked storage keeps the in-memory state and shows a small "progress can't be saved in this browser" notice;
- notifies subscribers, and listens for the `storage` event so other open tabs stay in sync;
- does export and import.

**Two exceptions:**
- Pages read progress through one `useProgress()` hook built on `useSyncExternalStore`.
- The pre-paint theme script in `<head>` is the only other code that reads storage, and it uses its own try/catch.

## 10. Proposed file layout

```
content/                          your Markdown (unchanged)
docs/superpowers/specs/           this document
src/app/
  layout.tsx                      top bar, theme script, sidebar shell
  page.tsx                        dashboard
  week/[week]/page.tsx            Overview step
  week/[week]/[step]/page.tsx     reading, Build & Test, Quiz steps
  review/page.tsx
  capstone/page.tsx
  progress/page.tsx               export / import
  globals.css                     plain CSS with custom properties, no UI framework (my call)
src/components/                   client components: sidebar + drawer, checkbox list, mark-as-read,
                                  flashcards, progress bar, search, theme toggle, code copy
src/lib/
  parse.ts                        Markdown → plan / notes structures; pure, no I/O
  parse.test.ts
  content.ts                      joins Velite output into weeks and steps
  storage.ts                      the one storage module (9.2)
  progress.ts                     pure rules from section 8: %, current week, spaced repetition
  progress.test.ts
velite.config.ts                  "plan" and "notes" collections; calls parse.ts, renders Markdown to HTML
next.config.ts                    output: 'export', trailingSlash: true, basePath from the environment
.github/workflows/deploy.yml
README.md
```

- **Rendering:** each chunk the parser produces (a section, the goal, an Apply part, a card) is turned into HTML at build time with the same plugins every time: remark-gfm, rehype-slug, and rehype-pretty-code with light and dark themes.
- **Heading levels:** shifted so each page's title is its only `h1`.

## 11. Parsing rules and warnings

- **Code fences first:** everything is fence-aware, so nothing inside ``` blocks is treated as a heading, list item or checkbox.
- **Warnings, not crashes:** each warning names the file and what was skipped. They're printed during the build, and none of them fails it. The build fails only if the plan yields zero weeks, with a clear message. Warnings include:
  - an unknown bold label in a week;
  - a week missing Goal, or with no checklists;
  - a notes link that resolves to no notes file;
  - a qualifier that can't be read (the link then contributes all sections);
  - an unnumbered `##` section inside the notes (it's kept as an extra reading step, so no content is lost);
  - a missing fixed section;
  - a question without an answer, or an answer without a question;
  - a notes file no week links to.
- **Notes links:** resolved by matching the link text to a notes title, ignoring case and the "Study Notes — " prefix. If that fails, they're resolved by the URL of an already-matched link.
- **Q&A pairing:** done by number, not position.
  - A question with no answer becomes a card whose back reads "No answer in the notes".
  - An answer with no question is dropped.
  - A count mismatch is a warning, never a crash.
  - Continuation lines of a multi-line item stay with that item.
- **Study item labels:** the leading bold text up to the colon. An item is optional when its label starts with "Optional".
- **Required unit tests (Vitest).** These read frozen copies of today's files from a fixtures folder, never `./content` itself, so editing content can't break CI or block a deploy **(my call)**.
  - Week extraction: against the frozen `study-plan.md` (10 weeks, titles, durations, Week 8's combined list, Week 9's single list) and a small fixture.
  - Checklist extraction: ids stay stable when an item is inserted, and duplicates get suffixes.
  - Q&A pairing: all 12 frozen notes files pair 12/12; a synthetic file with 3 questions and 2 answers warns and doesn't crash.
  - A `# comment` inside a code fence doesn't start a section.
  - One small test file for the section 8 rules.

## 12. Build, run, deploy

- **Scripts:**
  - `npm run dev` runs Velite in watch mode alongside `next dev`.
  - `npm test` runs Vitest.
  - `npm run build` runs `velite build`, then `next build`, then `pagefind --site out`.
  - `npm run preview` serves `out/` locally.
- **Search in dev:** search only works after a build (Pagefind indexes `out/`). The README says so.
- **Deploy:** a GitHub Actions workflow runs on every push to `main`. It does install → test → build, with the base path taken from `actions/configure-pages`, so the repository name isn't hard-coded. It then uploads `out/` and deploys with `actions/deploy-pages`. You turn on Pages once, under Settings → Pages → Source: GitHub Actions.
- **Before you deploy:**
  - The deployed site, and with it your notes, is public.
  - This folder isn't a git repo yet. The first build step creates one, adds `.superpowers/` (the mockup files) and `.velite/` and `out/` to `.gitignore`, and commits this document.
- **README:** how to add or update content (the conventions in sections 6 and 8.3, and what warnings mean), run locally, test, build and deploy.
- **Finish line:** build and tests pass, the dev server is running, and you get a short list of anything that didn't parse cleanly (the build warnings).

## 13. Left to the builder

- Component breakdown and naming.
- The exact visual polish within the reading targets in 7.1.
- How Velite is wired into Next: inside `next.config` or as a separate process.
- Pagefind's default UI or a small custom one.
- How copy buttons attach to code blocks.
- Whether import validation uses a schema library or a short hand-written check.
- Library versions: use current stable releases and follow Velite's Next.js guide for the version installed.
