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
      className="btn"
      onClick={() => {
        setTheme(next)
        setChoice(next)
      }}
    >
      {`Theme: ${theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'System'}`}
    </button>
  )
}

declare global {
  interface Window {
    PagefindUI: new (options: Record<string, unknown>) => unknown // set by pagefind-ui.js once it has loaded
  }
}

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

/** Adds a stylesheet or script to <head>. The promise settles when the file has loaded, or failed to. */
const addToHead = (el: HTMLLinkElement | HTMLScriptElement) =>
  new Promise((loaded, failed) => {
    el.onload = loaded
    el.onerror = failed
    document.head.append(el)
  })

/**
 * The Search button and its panel (spec 7.6), with Pagefind's own UI inside. `pagefind --site out` writes that UI after
 * the build, so it is fetched when the panel first opens, and `next dev` has none. Opening again reuses what is mounted.
 */
export function Search() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [missing, setMissing] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const requested = useRef(false)

  // Closes the panel. Focus that is in it goes to the Search button: the hidden panel would drop it to <body>. Every close but an
  // outside click comes through here; there the focus goes where the click lands.
  const close = () => {
    if (panel.current?.contains(document.activeElement)) button.current?.focus()
    setOpen(false)
  }

  // A new page closes the panel. A layout effect: the page is committed but not painted, and the panel is still shown with its focus.
  useLayoutEffect(close, [pathname]) // close uses only refs and a setter, so the copy from any render does the same

  // "/" opens it, unless the key is going into a field. The flashcard keys follow the same rule (cardKeyAction).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      e.preventDefault() // so the "/" doesn't land in the box that is about to get the focus
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    // The box takes the focus with the last search selected, so typing replaces it.
    const focusBox = () => {
      const input = panel.current?.querySelector('input')
      input?.focus()
      input?.select()
    }
    if (requested.current) {
      focusBox()
    } else {
      requested.current = true
      Promise.all([
        addToHead(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${base}/pagefind/pagefind-ui.css` })),
        addToHead(Object.assign(document.createElement('script'), { src: `${base}/pagefind/pagefind-ui.js` })),
      ]).then(
        () => {
          new window.PagefindUI({ element: '#search-panel', showSubResults: true, showImages: false, baseUrl: `${base}/`, autofocus: true })
          focusBox()
        },
        () => setMissing(true),
      )
    }
    // Capturing, so Escape gets here before Pagefind's box blurs itself on it, while the focus is still in the panel.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onPointer = (e: PointerEvent) => {
      if (![button.current, panel.current].some(el => el?.contains(e.target as Node))) setOpen(false)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn"
        aria-expanded={open}
        aria-controls="search-panel"
        aria-keyshortcuts="/"
        onClick={() => (open ? close() : setOpen(true))}
      >
        Search
      </button>
      <div
        id="search-panel"
        ref={panel}
        className="search-panel"
        hidden={!open}
        onClick={e => {
          // A result on the page already shown only moves to its heading: no route changes, which is what closes the panel otherwise.
          if ((e.target as Element).closest('a')) close()
        }}
      >
        {missing && <p>Search works in the built site: run npm run build, then npm run preview.</p>}
      </div>
    </>
  )
}
