# Backend study site

A static website that turns the Markdown in `content/` into a guided course: a 10-week backend Python study plan (Weeks 0–9) plus 12 notes files.

- Each week is a short run of pages: Overview, then the notes one section per page, then Build & Test, then a Quiz.
- Ticks, read marks and quiz results are saved in your browser. Cards you miss come back on the Review page after 1, 3 and 7 days.
- There is also a Capstone page, full-text search, and progress export/import.
- No server and no accounts. To change the course you edit the Markdown and rebuild; the code stays as it is.

## Run it locally

You need Node 24 (the deploy workflow uses the same).

```bash
npm install
npm run dev       # dev server, usually http://localhost:3000; rebuilds the content when you save a file in content/
npm test          # Vitest: the parser, the progress rules and the storage module
npm run build     # the static site in out/, then the search index
npm run preview   # serves out/ on http://localhost:1414 (run npm run build first)
```

**Search works only in a built site.** Pagefind indexes `out/` after the build, so use `npm run build`, then `npm run preview`. In `npm run dev` the Search panel only tells you that.

## Add or update content

Edit the files in `content/` and rebuild (the dev server does it when you save; reload the page). The rules below are what `src/lib/parse.ts` reads.

- `content/study-plan.md` is the plan. Keep this exact name.
- `content/<n>-<topic>-notes.md` are the notes. The name must end in `-notes.md`; the `<n>-` prefix is optional.

Adding a task, a week or a notes file needs no code change. Whatever the parser can't place becomes a [warning](#warnings), not a crash.

### The plan

```markdown
## Week 3 — PostgreSQL (5 days)

**Goal:** One paragraph: what you will have by Friday.

**Study notes:** [Week 3: PostgreSQL Indexes](https://example.com/a) (days 1–3), then [Testing: Unit, Integration and CI](https://example.com/b), sections 6–7

**Study, in order**

1. **Day 1:** Read this first.
2. **Optional, to go deeper:** A book.

**Build**

- [ ] One task
- [ ] Another task

**Test**

- [ ] One test
```

- **Week heading:** `## Week N — Title (duration)`. The number sets the order of the weeks. The duration in brackets is optional.
- **Fields:** a bold label with the colon inside the bold. These are `**Goal:**` (one paragraph) and `**Study notes:**`, plus `**Self-check:**` when a week has one (shown above the Quiz cards). Any other `**Name:**` field is a warning. A bold label with no colon (`**Build**`) heads a list instead, see below.
- **Study notes links:** a link belongs to a notes file when its text is that file's title (case and the "Study Notes — " prefix are ignored), or when its URL is the same as an already matched link's. That is how a short "Testing" link works. The link's own URL is otherwise unused, because the site points the link at its own pages. The reading pages follow the order of the links.
- **What follows a link** decides which sections become reading pages:
  - nothing: all the numbered sections of that file;
  - `sections 6–7` (or `section 6`): only those;
  - `the Week 4 part of "Apply it to the capstone"`: no reading pages, because that part appears on Build & Test;
  - `(days 1–3)`: no effect.

  A qualifier it can't read is a warning, and the link then gives all sections. That includes a reversed range (`sections 5–1`) and any number it has no place for, such as `sections 6, 7` or `sections 1 and 3`: write `sections 6–7`. A section number the notes file doesn't have is a warning too, and that page is missing. The text after each link is shown next to it on the Overview.
- **Study items:** a `**Study, in order**` line (any label starting with "Study" works) followed by a numbered list. An item can start with a bold label such as `**Day 1:**`, with the colon inside the bold. A label starting with "Optional" makes the item optional: it gets an "optional" tag and isn't needed to finish the Overview.
- **Checklists:** any `**Label**` line on its own, followed by a `- [ ]` list, becomes a checklist on the Build & Test page, titled with the label: Build, Test, Build + Test, and so on. A week without one gets a warning. The dashboard's current week is the lowest-numbered week with an unticked Build or Test box.
- **The end:** a `## Final capstone checklist` heading (any `##` heading containing "capstone checklist"), an intro sentence and `- [ ]` items feed the Capstone page.
- **The top:** everything between the title and the first week is the plan's intro ("About this plan" on the dashboard). A byline line right under the title (`date · author`) is dropped.

### Notes files

- **Title:** `# Study Notes — Week 1: Async Python`. The "Study Notes — " prefix is dropped, and the rest is the title that the plan's links are matched against. A byline under it (`date · author`) is dropped. The text before the first `##` is the intro shown on the Overview.
- **Concept sections:** `## 1. Title`, `## 2. Title`, and so on, one reading page each. `###` subsections stay on the page and appear in "On this page".
- **Closing sections**, with exactly these headings (case aside): `## Apply it to the capstone`, `## Check yourself`, `## Answers`, `## Sources`. A missing one is a warning.
- **Apply it to the capstone** appears on the Build & Test page of every week that links the file. If it is split into `### Week N: …` parts, only Week N's part is shown, on Week N, even when that week doesn't link the file. That is how the testing notes' Week 6 part reaches Week 6.
- **Check yourself and Answers** are numbered lists (`1. …`, at the start of the line), paired by number, not by position. An item may continue on the lines under it. Other text in Check yourself (an intro line, a closing paragraph) is shown above the quiz cards. A question without an answer becomes a card that reads "No answer in the notes". An answer without a question is dropped.
- **Which week's quiz:** a file's cards belong to the last (highest-numbered) week that links it. A week with no cards has no Quiz step.
- **Plain bullets:** `- [ ]` boxes inside the notes render as ordinary bullets. Only the plan's checklists can be ticked.
- **Code and diagrams:** a `# comment` inside a code fence is never read as a heading. A line like `&#91;embedded content: event loop cycle · 4 stages\]` (a diagram the export lost) is shown as a small "Diagram not included" note.

### What progress is attached to

Progress follows ids built from your content, so edit with this in mind:

| Progress | Id | Example | If you change it |
|---|---|---|---|
| Ticks on study, Build, Test and capstone items | `w<N>:` (`capstone:` for the final list) plus the item's text (a study item's bold label counts), lowercased, with runs of other characters as `-`, cut at 60 characters | `w3:seed-script-about-50k-events-and-1m-bookings` | **Rewording an item clears its tick.** Adding, removing or moving other items moves nothing. Items that start alike get `-2`, `-3` by position. |
| Read marks | `<notes slug>-<section number>` | `async-3` | **Renumbering sections moves the read marks.** |
| Quiz cards | `<notes slug>-q<question number>` | `async-q4` | **Renumbering questions moves the cards.** |
| Notes slug | the file name without the number prefix and `-notes.md`, with `_` as `-` | `1-async-notes.md` is `async`, `3-psql_indexes-notes.md` is `psql-indexes` | Renaming a file so its slug changes starts its read marks and cards over. Changing only the number prefix doesn't. |

Ids the content no longer uses stay in the browser and are ignored, so nothing breaks; the old tick just doesn't show.

### Warnings

The build prints each problem as one line, `[content] <file>: <warning>`, in the build log (and in the `npm run dev` terminal when the content rebuilds). A warning never fails the build: what it names is skipped or guessed, so read them after each edit. The build fails only when the plan has no `## Week N — …` headings.

| Warning | What to do |
|---|---|
| `Week N: no Goal` or `no checklists` | Add a `**Goal:**` line, or a `**Label**` line followed by a `- [ ]` list. |
| `Week N: unknown field "X"` | Only Goal, Study notes and Self-check are fields. |
| `Week N: "X" is not followed by a list`, `list without a **Label** line ignored`, `paragraph ignored` | A `**Label**` line must sit right above its list. Loose text inside a week is dropped. |
| `Week N: link "X" matches no notes file` | Make the link text the notes title, or reuse the URL of a link that matches. |
| `Week N: couldn't read "…" after "X"; using all sections` | Write the qualifier as `sections X–Y`, the lower number first. A list such as `sections 6, 7` isn't read. |
| `Week N: "X" names section M, which <file> doesn't have` | Fix the number in the plan, or add the section to the notes file. Until then that page is missing. |
| `<file>: not linked from any week` | Link the file from a week's Study notes line, or no page shows it. |
| `<file>: no "# Study Notes — …" title found` | Start the file with `# Study Notes — Title`. |
| `<file>: missing "## Apply it to the capstone"` (or Check yourself, Answers, Sources) | Add the section. |
| `unnumbered section "X" kept as section N`, `section number N appears twice` | Number it `## N. Title`. Until then it stays as an extra reading step. |
| `question N has no answer`, `answer N has no question`, `N questions but M answers`, `Answers: paragraph ignored` | Fix the numbering in Check yourself and Answers. Only numbered items count in Answers. |
| `unknown section "X" ignored` | After the first week, a `##` heading must be a week or the capstone checklist. |
| `duplicate …` or `… appears twice` | The first one is kept. Remove or renumber the other. |
| `<file>: has the same slug "x" as an earlier notes file` | Rename one of the files. |

## Progress and other devices

Progress is saved in your browser's localStorage, under keys that start with `backend-study:`. It is per browser and per site address, so `localhost:3000`, `localhost:1414` and the deployed site each keep their own, and clearing site data erases it.

To move it, open **Export / import** (`/progress`, linked in the sidebar outside the week pages). **Export** downloads `backend-study-progress-YYYY-MM-DD.json`. **Import** checks the file, asks before replacing everything on this device, and changes nothing if the file is bad.

## Deploy to GitHub Pages

**A GitHub Pages site is public, and so are your notes on it.** Decide that before the first push.

1. Create an empty GitHub repository and push `main`:

   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. Once, in the repository: **Settings → Pages → Source: GitHub Actions**.

That's all. `.github/workflows/deploy.yml` runs on every push to `main` (or by hand: Actions → Deploy to GitHub Pages → Run workflow, on `main`). It installs, runs `npm test`, builds, uploads `out/` and deploys it to `https://<you>.github.io/<repo>/`. If the first run failed because Pages wasn't switched on yet, run it again.

The base path (`/<repo>`) comes from `actions/configure-pages` and reaches the build as `NEXT_PUBLIC_BASE_PATH`, so the repository name isn't hard-coded and there is nothing to set. A failing test stops the deploy. The tests read frozen copies of the content in `src/lib/fixtures/`, never `content/`, so editing content can't fail them.
