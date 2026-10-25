import { basename } from 'node:path'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeSlug from 'rehype-slug'
import { defineCollection, defineConfig, defineLoader, s } from 'velite'
import { parseNotes, parsePlan, resolveNotesRefs } from './src/lib/parse'

// The parser does the splitting; the schemas below render each Markdown field to HTML under the same name.
// No `content` is returned, so a required Markdown field that comes out undefined fails ("The content is empty")
// instead of rendering the whole file.
const loader = defineLoader({
  test: /\.md$/,
  load: file => ({
    data: basename(file.path) === 'study-plan.md' ? parsePlan(String(file)) : parseNotes(String(file), basename(file.path)),
  }),
})

const task = s.object({ id: s.string(), text: s.markdown() })

const plan = defineCollection({
  name: 'Plan',
  pattern: 'study-plan.md',
  single: true,
  schema: s.object({
    title: s.string(),
    intro: s.markdown().optional(),
    weeks: s.array(
      s.object({
        n: s.number(),
        title: s.string(),
        duration: s.string().optional(),
        goal: s.markdown().optional(),
        selfCheck: s.markdown().optional(),
        notesRefs: s.array(
          s.object({
            label: s.string(),
            url: s.string(),
            after: s.string(), // plain text, often ''
            sections: s.union([s.array(s.number()), s.literal('all')]),
            slug: s.string().optional(),
          }),
        ),
        study: s.array(s.object({ id: s.string(), label: s.string().optional(), text: s.markdown(), optional: s.boolean() })),
        checklists: s.array(s.object({ title: s.string(), items: s.array(task) })),
      }),
    ),
    capstone: s.object({ intro: s.markdown().optional(), items: s.array(task) }),
    warnings: s.array(s.string()),
  }),
})

const notes = defineCollection({
  name: 'Notes',
  pattern: '*-notes.md',
  schema: s.object({
    slug: s.string(),
    file: s.string(),
    title: s.string(),
    intro: s.markdown().optional(),
    sections: s.array(s.object({ n: s.number(), title: s.string(), body: s.markdown().optional() })),
    apply: s.markdown().optional(),
    applyParts: s.array(s.object({ week: s.number(), body: s.markdown() })),
    quiz: s.object({
      intro: s.markdown().optional(),
      cards: s.array(s.object({ n: s.number(), question: s.markdown(), answer: s.markdown().optional() })),
    }),
    sources: s.markdown().optional(),
    warnings: s.array(s.string()),
  }),
})

export default defineConfig({
  root: 'content',
  strict: true,
  loaders: [loader],
  collections: { plan, notes },
  markdown: {
    copyLinkedFiles: false,
    rehypePlugins: [
      rehypeSlug,
      [rehypePrettyCode, { theme: { light: 'github-light', dark: 'github-dark' }, keepBackground: true, defaultLang: { block: 'text' } }],
    ],
  },
  // Runs once per build, before the JSON is written: resolves the plan's notes links in place and prints every warning.
  prepare({ plan, notes }) {
    const warnings = [
      ...plan.warnings.map(w => `study-plan.md: ${w}`),
      ...notes.flatMap(n => n.warnings.map(w => `${n.file}: ${w}`)),
      ...resolveNotesRefs(plan.weeks, notes),
    ]
    for (const w of warnings) console.warn(`[content] ${w}`)
    if (!plan.weeks.length) throw new Error('study-plan.md: no weeks found')
  },
})
