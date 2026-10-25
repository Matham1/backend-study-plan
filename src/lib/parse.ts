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

/** The `[label](url)` links of a Study notes field, each with the text after it and the sections it names. */
function notesRefsOf(text: string, week: number, warnings: string[]): NotesRef[] {
  const links = [...text.matchAll(LINK)]
  return links.map((link, i) => {
    const [, label, url] = link
    const after = text.slice(link.index + link[0].length, links[i + 1]?.index).trimEnd()
    const range = /sections?\s+(\d+)\s*[–-]\s*(\d+)/i.exec(after)
    const one = /sections?\s+(\d+)/i.exec(after)
    let sections: NotesRef['sections'] = 'all'
    if (range) sections = Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, k) => Number(range[1]) + k)
    else if (one) sections = [Number(one[1])]
    else if (/\bpart of\b/i.test(after)) sections = []
    else if (after.replace(/\(\s*days?\b[^)]*\)/gi, '').replace(/\b(?:then|and)\b/gi, '').replace(/[^\p{L}\p{N}]+/gu, ''))
      warnings.push(`Week ${week}: couldn't read "${after}" after "${label}"; using all sections`)
    return { label, url, after, sections }
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

  const headings: { at: number; text: string }[] = []
  lines.forEach((line, at) => {
    const m = fenced[at] ? null : SECTION_HEADING.exec(line)
    if (m) headings.push({ at, text: m[1] })
  })
  const firstWeek = headings.find(h => WEEK_HEADING.test(lines[h.at]))?.at

  // Title, then the byline (a non-empty line with " · ") is dropped; the intro runs to the first week.
  const titleAt = lines.findIndex((line, i) => !fenced[i] && TITLE.test(line))
  let introFrom = titleAt + 1
  if (titleAt >= 0) {
    const next = lines.findIndex((line, i) => i >= introFrom && line.trim() !== '')
    if (next >= 0 && lines[next].includes(' · ')) introFrom = next + 1
  }
  const plan: PlanData = {
    title: titleAt >= 0 ? TITLE.exec(lines[titleAt])![1] : '',
    intro: markdown(lines.slice(introFrom, firstWeek)),
    weeks: [],
    capstone: { items: [] },
    warnings,
  }

  let capstoneSeen = false
  headings.forEach((h, k) => {
    if (firstWeek === undefined || h.at < firstWeek) return
    const end = headings[k + 1]?.at ?? lines.length
    const body = lines.slice(h.at + 1, end)
    const mask = fenced.slice(h.at + 1, end)
    const week = WEEK_HEADING.exec(lines[h.at])
    if (week) {
      const n = Number(week[1])
      if (plan.weeks.some(w => w.n === n)) warnings.push(`Week ${n}: duplicate week number`)
      else plan.weeks.push(parseWeek(week, body, mask, warnings))
    } else if (/capstone checklist/i.test(h.text)) {
      if (capstoneSeen) warnings.push('duplicate capstone checklist ignored')
      else plan.capstone = parseCapstone(body, mask)
      capstoneSeen = true
    } else warnings.push(`unknown section "${h.text}" ignored`)
  })
  if (!plan.weeks.length) warnings.push('no "## Week N — …" headings found')
  return plan
}
