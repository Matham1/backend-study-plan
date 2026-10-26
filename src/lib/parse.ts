// Pure parsers: Markdown text in, plain data out. No I/O. Nothing here throws on odd content;
// whatever the parser can't place becomes a string in `warnings`, and the build only prints it.

export type TaskData = { id: string; text: string }
export type StudyItemData = { id: string; label?: string; text: string; optional: boolean }
export type NotesRef = { label: string; url: string; after: string; sections: number[] | 'all'; slug?: string }
export type WeekData = {
  n: number
  title: string
  duration?: string
  goal?: string
  selfCheck?: string
  notesRefs: NotesRef[]
  study: StudyItemData[]
  checklists: { title: string; items: TaskData[] }[]
}
export type PlanData = {
  title: string
  intro?: string
  weeks: WeekData[]
  capstone: { intro?: string; items: TaskData[] }
  warnings: string[]
}
export type CardData = { n: number; question: string; answer?: string }
export type NotesData = {
  slug: string
  file: string
  title: string
  intro?: string
  sections: { n: number; title: string; body?: string }[]
  apply?: string
  applyParts: { week: number; body: string }[]
  quiz: { intro?: string; cards: CardData[] }
  sources?: string
  warnings: string[]
}

/** Plain text of inline Markdown, for ids and titles. Underscores stay. */
export function plainText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([!-\/:-@[-`{-~])|[*`]/g, (_, escaped?: string) => escaped ?? '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, num: string) => {
      const code = /^x/i.test(num) ? parseInt(num.slice(1), 16) : parseInt(num, 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase a-z0-9 slug: runs of anything else become one dash; cut to `max`. */
export function textSlug(text: string, max = 60): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}

/**
 * True for every line inside a fenced code block, fence lines included. A fence opens on a line that
 * starts (after indentation) with ``` or ~~~ and closes on the same character repeated at least as
 * many times with no info string. Nothing inside a fence is structure.
 */
function fenceMask(lines: string[]): boolean[] {
  let open: { char: string; len: number } | null = null
  return lines.map(line => {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (!open) {
      if (m) open = { char: m[1][0], len: m[1].length }
      return m !== null
    }
    if (m && m[1][0] === open.char && m[1].length >= open.len && !m[2].trim()) open = null
    return true
  })
}

const TITLE = /^#\s+(\S.*?)\s*$/
const SECTION_HEADING = /^##\s+(\S.*?)\s*$/
const WEEK_HEADING = /^##\s+Week\s+(\d+)\s*[—–-]\s*(.+?)(?:\s*\(([^)]*\d[^)]*)\))?\s*$/
const FIELD = /^\*\*([^*]+?):\*\*\s*(.*)$/ // **Label:** rest
const LABEL = /^\*\*([^*]+)\*\*$/ // **Label** alone on its line
const CHECK_ITEM = /^[-*+]\s+\[[ xX]\]\s+(\S.*)$/ // - [ ] text
const NUMBERED_ITEM = /^\d+[.)]\s+(\S.*)$/ // 1. text
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g

const joined = (lines: string[]) => lines.join('\n').trim()
/** A Markdown field value is never '' (Velite rejects empty Markdown), so empty becomes undefined. */
const markdown = (lines: string[]) => joined(lines) || undefined

type Section = { at: number; text: string; body: string[]; fenced: boolean[] }

/** The `## ` headings outside fences, each with the lines (and their fence flags) under it, up to the next heading. */
function sectionsOf(lines: string[], fenced: boolean[]): Section[] {
  const heads = lines.flatMap((line, at) => {
    const m = fenced[at] ? null : SECTION_HEADING.exec(line)
    return m ? [{ at, text: m[1] }] : []
  })
  return heads.map((h, k) => {
    const end = heads[k + 1]?.at ?? lines.length
    return { ...h, body: lines.slice(h.at + 1, end), fenced: fenced.slice(h.at + 1, end) }
  })
}

/**
 * The two header lines that are not intro: the first `# ` line outside fences (`title` is its text), and the
 * byline right after it (a non-empty line with " · "). Each `...At` is a line index, or -1 when there is none.
 */
function header(lines: string[], fenced: boolean[]): { title: string; titleAt: number; bylineAt: number } {
  const titleAt = lines.findIndex((line, i) => !fenced[i] && TITLE.test(line))
  const next = titleAt < 0 ? -1 : lines.findIndex((line, i) => i > titleAt && line.trim() !== '')
  return {
    title: titleAt < 0 ? '' : TITLE.exec(lines[titleAt])![1],
    titleAt,
    bylineAt: next >= 0 && lines[next].includes(' · ') ? next : -1,
  }
}

type ListBlock = { kind: 'list'; check: boolean; items: string[][] }
type Block =
  | { kind: 'field'; label: string; lines: string[] }
  | { kind: 'label'; label: string }
  | { kind: 'paragraph'; lines: string[] }
  | ListBlock

/**
 * Groups a section body into `**Label:** text` fields, `**Label**` lines, lists of `- [ ]` or `1.` items,
 * and free paragraphs (anything else). A field, item or paragraph keeps taking the lines right under it
 * (wrapped text). After a blank line, an indented line continues the last list item and keeps the blank
 * line in its text, so a loose list stays one list. Fenced lines are skipped.
 */
function blocks(lines: string[], fenced: boolean[]): Block[] {
  const out: Block[] = []
  let tail: string[] | null = null // the field, item or paragraph that still takes wrapped lines
  let list: ListBlock | null = null
  let item: string[] | null = null // the last list item: after a blank line, an indented line continues it
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (fenced[i] || !line) {
      tail = null
      continue
    }
    const field = FIELD.exec(line)
    const label = LABEL.exec(line)
    const task = CHECK_ITEM.exec(line)
    const entry = task ?? NUMBERED_ITEM.exec(line)
    if (field) {
      out.push({ kind: 'field', label: field[1].trim(), lines: (tail = [field[2]]) })
      list = item = null
    } else if (label) {
      out.push({ kind: 'label', label: label[1].trim() })
      tail = list = item = null
    } else if (entry) {
      const check = task !== null
      if (!list || list.check !== check) out.push((list = { kind: 'list', check, items: [] }))
      list.items.push((item = tail = [entry[1]]))
    } else if (tail) tail.push(line)
    else if (item && /^\s/.test(lines[i])) {
      // no tail but an open item: the previous line was blank (or fenced)
      item.push('', line)
      tail = item
    } else {
      out.push({ kind: 'paragraph', lines: (tail = [line]) })
      list = item = null
    }
  }
  return out
}

/** The first 40 characters of some lines as plain text, to point at them in a warning. */
const excerpt = (lines: string[]) => plainText(joined(lines)).slice(0, 40)

/** Hands out `<prefix><slug>` ids from item text; a slug already used in this scope gets -2, -3, … */
function idScope(prefix: string): (text: string) => string {
  const used = new Set<string>()
  return text => {
    const slug = textSlug(plainText(text))
    let id = slug
    for (let n = 2; used.has(id); n++) id = `${slug}-${n}`
    used.add(id)
    return prefix + id
  }
}

const taskOf = (id: (text: string) => string) => (lines: string[]): TaskData => {
  const text = joined(lines)
  return { id: id(text), text }
}

/**
 * The sections the text after a notes link names: `sections 2–4` or `section 7`; none for "the Week 4 part of …"; all when
 * only a "(days 1–3)" note and filler words are left. Undefined when it says more than that: a reversed range, or a number no
 * form above accounts for (`sections 6, 7` would give just 6, and the 7 would drop out unseen).
 */
function sectionsNamed(after: string): NotesRef['sections'] | undefined {
  const range = /sections?\s+(\d+)\s*[–-]\s*(\d+)/i.exec(after)
  const one = /sections?\s+(\d+)/i.exec(after)
  const rest = after.replace((range ?? one)?.[0] ?? '', '').replace(/\(\s*days?\b[^)]*\)|\bWeek\s+\d+\s+part\s+of\b/gi, '')
  if (/\d/.test(rest)) return undefined
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])]
    return lo > hi ? undefined : Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)
  }
  if (one) return [Number(one[1])]
  if (/\bpart\s+of\b/i.test(after)) return []
  return /[\p{L}\p{N}]/u.test(rest.replace(/\b(?:then|and)\b/gi, '')) ? undefined : 'all'
}

/** The `[label](url)` links of a Study notes field, each with the text after it and the sections it names. */
function notesRefsOf(text: string, week: number, warnings: string[]): NotesRef[] {
  const links = [...text.matchAll(LINK)]
  return links.map((link, i) => {
    const [, label, url] = link
    const after = text.slice(link.index + link[0].length, links[i + 1]?.index).trimEnd()
    const sections = sectionsNamed(after)
    if (!sections) warnings.push(`Week ${week}: couldn't read "${after}" after "${label}"; using all sections`)
    return { label, url, after, sections: sections ?? 'all' }
  })
}

function parseWeek(head: RegExpExecArray, body: string[], fenced: boolean[], warnings: string[]): WeekData {
  const n = Number(head[1])
  const week: WeekData = { n, title: head[2], duration: head[3], notesRefs: [], study: [], checklists: [] }
  const id = idScope(`w${n}:`) // study items and checklists share it
  const task = taskOf(id)
  const studyItem = (lines: string[]): StudyItemData => {
    const raw = joined(lines)
    const m = /^\*\*([^*]+?):\*\*\s*(\S[\s\S]*)$/.exec(raw)
    const label = m?.[1].trim() || undefined
    return { id: id(raw), label, text: m ? m[2] : raw, optional: /^optional/i.test(label ?? '') }
  }
  const unlisted = (label: string) => warnings.push(`Week ${n}: "${label}" is not followed by a list`)

  const seen = new Set<string>() // Goal / Self-check fields already read: the first one wins
  let label: string | undefined // a **Label** line still waiting for its list
  for (const b of blocks(body, fenced)) {
    if (b.kind === 'field') {
      const key = b.label.toLowerCase()
      if (key === 'goal' || key === 'self-check') {
        if (seen.has(key)) warnings.push(`Week ${n}: duplicate field "${b.label}" ignored`)
        else week[key === 'goal' ? 'goal' : 'selfCheck'] = markdown(b.lines)
        seen.add(key)
      } else if (key === 'study notes') week.notesRefs.push(...notesRefsOf(b.lines.join('\n'), n, warnings))
      else warnings.push(`Week ${n}: unknown field "${b.label}"`)
    } else if (b.kind === 'label') {
      if (label !== undefined) unlisted(label)
      label = b.label
    } else if (b.kind === 'paragraph') {
      warnings.push(`Week ${n}: paragraph ignored ("${excerpt(b.lines)}")`)
    } else if (label === undefined) {
      warnings.push(`Week ${n}: list without a **Label** line ignored ("${excerpt(b.items[0])}")`)
    } else {
      if (b.check) week.checklists.push({ title: label, items: b.items.map(task) })
      else if (/^study\b/i.test(label)) week.study.push(...b.items.map(studyItem))
      else unlisted(label)
      label = undefined
    }
  }
  if (label !== undefined) unlisted(label)
  if (!week.goal) warnings.push(`Week ${n}: no Goal`)
  if (!week.checklists.length) warnings.push(`Week ${n}: no checklists`)
  return week
}

function parseCapstone(body: string[], fenced: boolean[]): PlanData['capstone'] {
  const task = taskOf(idScope('capstone:'))
  const firstItem = body.findIndex((line, i) => !fenced[i] && CHECK_ITEM.test(line.trim()))
  return {
    intro: markdown(body.slice(0, firstItem < 0 ? body.length : firstItem)),
    items: blocks(body, fenced).flatMap(b => (b.kind === 'list' && b.check ? b.items.map(task) : [])),
  }
}

export function parsePlan(md: string): PlanData {
  const lines = md.split(/\r?\n/)
  const fenced = fenceMask(lines)
  const warnings: string[] = []

  const sections = sectionsOf(lines, fenced)
  const firstWeek = sections.find(s => WEEK_HEADING.test(lines[s.at]))?.at

  // Title, then the byline is dropped; the intro runs to the first week.
  const { title, titleAt, bylineAt } = header(lines, fenced)
  const plan: PlanData = {
    title,
    intro: markdown(lines.slice(Math.max(titleAt, bylineAt) + 1, firstWeek)),
    weeks: [],
    capstone: { items: [] },
    warnings,
  }

  let capstoneSeen = false
  for (const { at, text, body, fenced: mask } of sections) {
    if (firstWeek === undefined || at < firstWeek) continue
    const week = WEEK_HEADING.exec(lines[at])
    if (week) {
      const n = Number(week[1])
      if (plan.weeks.some(w => w.n === n)) warnings.push(`Week ${n}: duplicate week number`)
      else plan.weeks.push(parseWeek(week, body, mask, warnings))
    } else if (/capstone checklist/i.test(text)) {
      if (capstoneSeen) warnings.push('duplicate capstone checklist ignored')
      else plan.capstone = parseCapstone(body, mask)
      capstoneSeen = true
    } else warnings.push(`unknown section "${text}" ignored`)
  }
  if (!plan.weeks.length) warnings.push('no "## Week N — …" headings found')
  return plan
}

// ── Notes ──────────────────────────────────────────────────────────────────────────────────────────

const NOTES_PREFIX = /^Study Notes\s*[—–-]\s*/i
const NUMBERED_SECTION = /^(\d+)\.\s+(.*)$/ // "3. Title"
const WEEK_PART = /^###\s+Week\s+(\d+)\b/ // "### Week 4: …"
const QA_ITEM = /^(\d+)[.)]\s+(\S.*)$/ // "4. text", at column 0; \S keeps an item's text from being empty
const CHECKBOX = /^(\s*[-*+]\s+)\[[ xX]\]\s+/ // the "[ ] " of a bullet
const LOST_DIAGRAM = /^&#91;embedded content: (.*?)\\?\]\s*$/ // a diagram the export could not keep
const FIXED = ['Apply it to the capstone', 'Check yourself', 'Answers', 'Sources']

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `3-psql_indexes-notes.md` becomes `psql-indexes`: no number prefix, no `-notes.md`, `_` as `-`. */
export function notesSlug(fileName: string): string {
  const m = /^(?:\d+-)?(.*?)-notes\.md$/.exec(fileName)
  return (m ? m[1] : fileName.replace(/\.md$/, '')).replace(/_/g, '-')
}

/** Export leftovers, fixed line by line outside fences: a `- [ ]` loses its box, a lost diagram becomes a grey note. */
function tidy(lines: string[], fenced: boolean[]): string[] {
  return lines.map((line, i) => {
    if (fenced[i]) return line
    const lost = LOST_DIAGRAM.exec(line)
    return lost ? `<p class="diagram-missing">Diagram not included: ${escapeHtml(lost[1])}</p>` : line.replace(CHECKBOX, '$1')
  })
}

/** `###` and `####` headings go up one level, so a step page's own title is its only top-level heading. */
const lift = (lines: string[], fenced: boolean[]) =>
  lines.map((line, i) => (fenced[i] ? line : line.replace(/^#(#{2,3})(?=\s)/, '$1')))

type Item = { n: number; text: string }
type Numbered = { items: Item[]; others: string[][] }

/**
 * Splits Check yourself or Answers into `N. text` items (at column 0) and the paragraphs around them. An item
 * takes the lines right under it and, after a blank line, indented ones; its text joins them with newlines and
 * drops their indentation. Fenced lines are never items: a fence stays whole, with the block it opens in.
 */
function numbered(lines: string[], fenced: boolean[]): Numbered {
  const items: { n: number; lines: string[] }[] = []
  const others: string[][] = []
  let tail: string[] | null = null // the item or paragraph that still takes wrapped lines
  let item: string[] | null = null // the last item: after a blank line, an indented line continues it
  let indent = 0 // how far the open fence is indented; the fenced lines under it lose that much
  const indentOf = (text: string) => text.length - text.trimStart().length
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (fenced[i] && fenced[i - 1]) {
      // inside a fence: stays with the block the fence opened in (the opener set `tail`)
      tail!.push(text.slice(Math.min(indent, indentOf(text))))
      continue
    }
    const line = text.trim()
    if (!line) {
      tail = null
      continue
    }
    const m = QA_ITEM.exec(text)
    if (m) items.push({ n: Number(m[1]), lines: (tail = item = [m[2]]) })
    else if (tail) tail.push(line)
    else if (item && /^\s/.test(text)) {
      item.push('', line)
      tail = item
    } else {
      others.push((tail = [line]))
      item = null
    }
    if (fenced[i]) indent = indentOf(text)
  }
  return { items: items.map(({ n, lines }) => ({ n, text: joined(lines) })), others }
}

/** The `### Week N` chunks of an Apply section, heading included. A week named twice keeps its first chunk. */
function applyPartsOf(apply: Section, warnings: string[]): NotesData['applyParts'] {
  const starts = apply.body.flatMap((line, i) => {
    const m = apply.fenced[i] ? null : WEEK_PART.exec(line)
    return m ? [{ at: i, week: Number(m[1]) }] : []
  })
  const parts: NotesData['applyParts'] = []
  starts.forEach(({ at, week }, k) => {
    if (parts.some(p => p.week === week)) warnings.push(`"### Week ${week}" appears twice in Apply; kept the first`)
    else parts.push({ week, body: joined(apply.body.slice(at, starts[k + 1]?.at)) })
  })
  return parts
}

/**
 * One card per question, in question order, with the answer of the same number. An answer with no question
 * is dropped. A number used twice keeps its first text. With a section missing there is nothing to pair,
 * and `missing` already said so.
 */
function pairCards(asked: Numbered | undefined, answered: Numbered | undefined, warnings: string[]): CardData[] {
  const repeats: string[] = []
  const firstOf = (kind: string, found: Item[] = []) =>
    found.filter((x, i) => {
      const repeat = found.findIndex(y => y.n === x.n) < i
      if (repeat) repeats.push(`${kind} ${x.n} appears twice; kept the first`)
      return !repeat
    })
  const questions = firstOf('question', asked?.items)
  const answers = firstOf('answer', answered?.items)
  const answerOf = new Map(answers.map(a => [a.n, a.text]))
  const cards = questions.map(q => ({ n: q.n, question: q.text, answer: answerOf.get(q.n) }))
  if (asked && answered) {
    warnings.push(...cards.filter(c => !c.answer).map(c => `question ${c.n} has no answer`))
    warnings.push(...answers.filter(a => !questions.some(q => q.n === a.n)).map(a => `answer ${a.n} has no question`))
    if (questions.length !== answers.length) warnings.push(`${questions.length} questions but ${answers.length} answers`)
  }
  warnings.push(...repeats)
  return cards
}

export function parseNotes(md: string, fileName: string): NotesData {
  const raw = md.split(/\r?\n/)
  const fenced = fenceMask(raw)
  const lines = tidy(raw, fenced)
  const sections = sectionsOf(lines, fenced)
  const { title: heading, titleAt, bylineAt } = header(lines, fenced)
  const title = heading.replace(NOTES_PREFIX, '')
  const warnings: string[] = []
  if (!title) warnings.push('no "# Study Notes — …" title found')

  // Numbered sections are the reading steps. A heading with no number, or a number already taken, is kept
  // as one more step numbered after the highest, so no content is lost.
  const fixed = new Map<string, Section>()
  const steps: NotesData['sections'] = []
  const used = new Set<number>()
  let top = Math.max(0, ...sections.map(s => Number(NUMBERED_SECTION.exec(s.text)?.[1] ?? 0)))
  for (const s of sections) {
    const name = FIXED.find(f => f.toLowerCase() === s.text.toLowerCase())
    if (name) {
      if (fixed.has(name)) warnings.push(`duplicate "## ${name}" ignored`)
      else fixed.set(name, s)
      continue
    }
    const m = NUMBERED_SECTION.exec(s.text)
    let n = Number(m?.[1]) // NaN without a number
    if (!m || used.has(n)) {
      n = ++top
      warnings.push(
        m ? `section number ${m[1]} appears twice; "${s.text}" kept as section ${n}` : `unnumbered section "${s.text}" kept as section ${n}`,
      )
    }
    used.add(n)
    steps.push({ n, title: plainText(m ? m[2] : s.text), body: markdown(lift(s.body, s.fenced)) })
  }
  for (const name of FIXED) if (!fixed.has(name)) warnings.push(`missing "## ${name}"`)

  const apply = fixed.get('Apply it to the capstone')
  const applyParts = apply ? applyPartsOf(apply, warnings) : []

  const qa = (name: string) => {
    const s = fixed.get(name)
    return s && numbered(s.body, s.fenced)
  }
  const asked = qa('Check yourself')
  const answered = qa('Answers')
  for (const p of answered?.others ?? []) warnings.push(`Answers: paragraph ignored ("${excerpt(p)}")`)
  const cards = pairCards(asked, answered, warnings)

  const sources = fixed.get('Sources')
  return {
    slug: notesSlug(fileName),
    file: fileName,
    title,
    intro: markdown(lines.slice(0, sections[0]?.at).filter((_, i) => i !== titleAt && i !== bylineAt)),
    sections: steps,
    apply: apply && markdown(apply.body),
    applyParts,
    quiz: { intro: markdown((asked?.others ?? []).flatMap((p, k) => (k ? ['', ...p] : p))), cards },
    sources: sources && markdown(sources.body),
    warnings,
  }
}

/**
 * Sets `ref.slug` on every plan link: first by matching its text to a notes title (case and a
 * "Study Notes — " prefix ignored), then, for the rest, by the URL of a link that did match.
 * Returns warnings for links that match nothing and for notes no link reaches, each starting with
 * the file it is about (`study-plan.md: …` or `<notes file>: …`).
 */
export function resolveNotesRefs(
  weeks: { n: number; notesRefs: NotesRef[] }[],
  notes: { slug: string; file: string; title: string }[],
): string[] {
  const key = (title: string) => title.replace(NOTES_PREFIX, '').trim().toLowerCase()
  const refs = weeks.flatMap(w => w.notesRefs.map(ref => ({ week: w.n, ref })))
  const slugByUrl = new Map<string, string>()
  for (const { ref } of refs) {
    ref.slug = notes.find(n => key(n.title) === key(ref.label))?.slug
    if (ref.slug && !slugByUrl.has(ref.url)) slugByUrl.set(ref.url, ref.slug)
  }
  for (const { ref } of refs) ref.slug ??= slugByUrl.get(ref.url)
  const linked = new Set(refs.map(r => r.ref.slug))
  return [
    ...refs.filter(r => !r.ref.slug).map(r => `study-plan.md: Week ${r.week}: link "${r.ref.label}" matches no notes file`),
    ...notes.filter(n => !linked.has(n.slug)).map(n => `${n.file}: not linked from any week`),
    // two files with one slug would hide each other from every lookup by slug
    ...notes.filter((n, i) => notes.findIndex(m => m.slug === n.slug) < i).map(n => `${n.file}: has the same slug "${n.slug}" as an earlier notes file`),
  ]
}

/**
 * One warning per section number a plan link names that its notes file doesn't have (`sections 6–12` of a file with 10).
 * Run it after `resolveNotesRefs`, which sets the slugs; a link that matched no file was reported there.
 */
export function checkRefSections(
  weeks: { n: number; notesRefs: NotesRef[] }[],
  notes: { slug: string; file: string; sections: { n: number }[] }[],
): string[] {
  return weeks.flatMap(w =>
    w.notesRefs.flatMap(ref => {
      const doc = notes.find(d => d.slug === ref.slug)
      if (!doc || ref.sections === 'all') return []
      return ref.sections
        .filter(n => !doc.sections.some(s => s.n === n))
        .map(n => `study-plan.md: Week ${w.n}: "${ref.label}" names section ${n}, which ${doc.file} doesn't have`)
    }),
  )
}
