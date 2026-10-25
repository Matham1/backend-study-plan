'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TocItem } from '../lib/content'
import { getTheme, setTheme } from '../lib/storage'

/** Puts a Copy button after each highlighted code block under `root`. Returns the function that takes them off again. */
function addCopyButtons(root: HTMLElement): () => void {
  const buttons = [...root.querySelectorAll('figure[data-rehype-pretty-code-figure] pre')].map(pre => {
    const button = document.createElement('button')
    let timer: number | undefined
    button.type = 'button'
    button.className = 'btn copy'
    button.textContent = 'Copy'
    button.setAttribute('aria-live', 'polite')
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent ?? '')
      } catch {
        return // no clipboard on this page (it isn't https) or the browser refused: the label stays "Copy"
      }
      button.textContent = 'Copied'
      clearTimeout(timer)
      timer = window.setTimeout(() => (button.textContent = 'Copy'), 1500)
    }
    pre.after(button) // beside the <pre>, not in it, so pre.textContent stays the code alone
    return button
  })
  return () => buttons.forEach(button => button.remove())
}

function TocList({ toc }: { toc: TocItem[] }) {
  return (
    <ul>
      {toc.map((item, i) => (
        <li key={i} data-level={item.level}>
          <a href={`#${item.id}`}>{item.title}</a>
        </li>
      ))}
    </ul>
  )
}

/** The docs frame: sidebar (a drawer below 800px), the reading column, and "On this page" (a block at the top of the column below 1100px). */
export function DocLayout({ sidebar, toc = [], children }: { sidebar: ReactNode; toc?: TocItem[]; children: ReactNode }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [openedFor, setOpenedFor] = useState(pathname)
  if (pathname !== openedFor) {
    // A new page closes the drawer. Setting state while rendering is React's way to do that without an extra paint.
    setOpenedFor(pathname)
    setOpen(false)
  }
  const menu = useRef<HTMLButtonElement>(null)
  const drawer = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    drawer.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      menu.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => (main.current ? addCopyButtons(main.current) : undefined), [pathname])

  useLayoutEffect(() => {
    // A long week's list scrolls inside the sidebar, and every page starts it at the top: bring the current step into view
    // before the first paint, so stepping through a week doesn't flicker.
    const list = drawer.current
    const here = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (list && here) list.scrollTop = here.offsetTop - (list.clientHeight - here.offsetHeight) / 2
  }, [pathname])

  const hasToc = toc.length > 0
  return (
    <div className="docs" data-drawer={open ? 'open' : 'closed'}>
      <div className="menubar">
        <button
          ref={menu}
          type="button"
          className="btn"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen(!open)}
        >
          ☰ Menu
        </button>
      </div>
      <div
        id="sidebar"
        ref={drawer}
        className="sidebar"
        tabIndex={-1}
        onClick={e => {
          // Going to the page already shown changes no route, which is what closes the drawer otherwise.
          if ((e.target as Element).closest('a')) setOpen(false)
        }}
      >
        {sidebar}
      </div>
      {open && <div className="backdrop" aria-hidden="true" onClick={() => setOpen(false)} />}
      <main id="main" ref={main} tabIndex={-1}>
        {hasToc && (
          <details className="toc-inline">
            <summary>On this page</summary>
            <TocList toc={toc} />
          </details>
        )}
        {children}
      </main>
      {hasToc && (
        <nav className="toc" aria-label="On this page">
          <p className="toc-title">On this page</p>
          <TocList toc={toc} />
        </nav>
      )}
    </div>
  )
}

/** System → Light → Dark → System. It renders nothing until mounted, because the saved choice isn't known on the server. */
export function ThemeToggle() {
  const [theme, setChoice] = useState<'light' | 'dark' | null | undefined>(undefined)
  useEffect(() => setChoice(getTheme()), [])
  if (theme === undefined) return null
  const next = theme === null ? 'light' : theme === 'light' ? 'dark' : null
  return (
    <button
      type="button"
      className="btn theme-toggle"
      onClick={() => {
        setTheme(next)
        setChoice(next)
      }}
    >
      {`Theme: ${theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System'}`}
    </button>
  )
}
