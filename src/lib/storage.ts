// The one module that touches localStorage (spec 9.2). Every access is in a try/catch, so blocked, full or missing
// storage (private mode, quota, server rendering) never throws: the in-memory state keeps working.
// No 'use client' here, so server files can import THEME_SCRIPT.
// `import * as React` on purpose: Next refuses a named hook import (`import { useSyncExternalStore }`) in any module a
// server file imports, even though only client components ever call these hooks.
import * as React from 'react'
import type { CardState, Progress } from './progress'

export const PROGRESS_KEY = 'backend-study:progress:v1'
export const THEME_KEY = 'backend-study:theme'
export const EMPTY_PROGRESS: Progress = { version: 1, updatedAt: '', checks: {}, read: {}, cards: {} }

const NOT_OURS = "This isn't a progress file from this site."
// ponytail: shape only, so 2026-13-45 passes and just sorts oddly. Add a Date.parse check if hand-edited files turn up.
const DAY = /^\d{4}-\d{2}-\d{2}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTicks = (v: unknown): v is Record<string, true> => isObject(v) && Object.values(v).every(x => x === true)
const isCard = (c: unknown): c is CardState =>
  isObject(c) && (c.box === 0 || ((c.box === 1 || c.box === 2 || c.box === 3) && typeof c.due === 'string' && DAY.test(c.due)))
const isCards = (v: unknown): v is Record<string, CardState> => isObject(v) && Object.values(v).every(isCard)

/** Checks the text of a progress file (an import, or the stored value). Unknown ids are kept, unknown top-level fields dropped. */
export function parseProgress(text: string): { ok: true; progress: Progress } | { ok: false; error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: "This file isn't valid JSON." }
  }
  if (!isObject(data)) return { ok: false, error: NOT_OURS }
  if (typeof data.version === 'number' && data.version !== 1)
    return { ok: false, error: `This progress file has version ${data.version}; this site reads version 1.` }
  const { version, updatedAt, checks, read, cards, lastVisited } = data
  if (
    version !== 1 ||
    typeof updatedAt !== 'string' ||
    !isTicks(checks) ||
    !isTicks(read) ||
    !isCards(cards) ||
    (lastVisited !== undefined && typeof lastVisited !== 'string')
  )
    return { ok: false, error: NOT_OURS }
  return { ok: true, progress: { version, updatedAt, checks, read, cards, ...(lastVisited !== undefined && { lastVisited }) } }
}

let cache: Progress | undefined // undefined until the first read
let unbacked: string | undefined // the stored text that failed to parse and could not be backed up; set by every read
let saveFailed = false
let listening = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())

/** Copies a corrupt stored value to a backup key. False when there is no room. */
function backUp(text: string): boolean {
  try {
    localStorage.setItem(`${PROGRESS_KEY}:backup-${new Date().toISOString()}`, text)
    return true
  } catch {
    return false
  }
}

/**
 * The stored progress. A value that fails `parseProgress` is copied to a backup key and left in place until the next
 * write. If the copy fails, `unbacked` keeps the text and `save` won't write over it until a retry works.
 */
function readStored(): Progress {
  unbacked = undefined
  let text: string | null
  try {
    text = localStorage.getItem(PROGRESS_KEY)
  } catch {
    return EMPTY_PROGRESS
  }
  if (text === null) return EMPTY_PROGRESS
  const result = parseProgress(text)
  if (result.ok) return result.progress
  if (!backUp(text)) unbacked = text
  return EMPTY_PROGRESS
}

/** The same object on every call until `update`, `replaceProgress` or a change from another tab. React needs that. */
export function getProgress(): Progress {
  return (cache ??= readStored())
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!listening && typeof window !== 'undefined') {
    listening = true
    // Another tab wrote (or, with a null key, cleared) the storage: read it again.
    window.addEventListener('storage', e => {
      if (e.key === null || e.key === PROGRESS_KEY) {
        cache = readStored()
        notify()
      }
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Writes `p` to storage. False when it could not be written, or must not be: a corrupt value without a backup is never written over. */
function save(p: Progress): boolean {
  if (unbacked !== undefined) {
    if (!backUp(unbacked)) return false
    unbacked = undefined
  }
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p))
    return true
  } catch {
    return false
  }
}

/** Applies `change` to the current progress and saves the result with a new `updatedAt`. A failed save keeps the state in memory. */
export function update(change: (p: Progress) => Progress): void {
  const next = { ...change(getProgress()), updatedAt: new Date().toISOString() }
  cache = next
  saveFailed = !save(next)
  notify()
}

export function replaceProgress(p: Progress): void {
  update(() => p)
}

export const isSaveFailed = (): boolean => saveFailed

export function useProgress(): Progress | null {
  return React.useSyncExternalStore<Progress | null>(subscribe, getProgress, () => null)
}

export function useSaveFailed(): boolean {
  return React.useSyncExternalStore(subscribe, isSaveFailed, () => false)
}

export function getTheme(): 'light' | 'dark' | null {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : null
  } catch {
    return null
  }
}

/** Saves the choice (null = follow the system) and applies it to the page. The page changes even if the save fails. */
export function setTheme(t: 'light' | 'dark' | null): void {
  try {
    if (t) localStorage.setItem(THEME_KEY, t)
    else localStorage.removeItem(THEME_KEY)
  } catch {
    // not saved: the choice lasts until the page is closed
  }
  if (t) document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
}

/** Inlined in <head> to apply the saved theme before the first paint. It runs outside the app, so it has its own try/catch. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`
