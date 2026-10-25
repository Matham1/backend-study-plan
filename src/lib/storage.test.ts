import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
afterEach(() => vi.useRealTimers())

const KEY = 'backend-study:progress:v1'
const THEME = 'backend-study:theme'
const NOT_OURS = "This isn't a progress file from this site."
const stored = { version: 1, updatedAt: '2026-10-25T10:00:00.000Z', checks: { 'w9:gone': true }, read: { 'async-1': true }, cards: { 'x-q1': { box: 1, due: '2026-10-26' } } }
const withBase = (over: object) => JSON.stringify({ version: 1, updatedAt: '', checks: {}, read: {}, cards: {}, ...over })

describe('module', () => {
  it('pins the keys and the empty state', async () => {
    const { PROGRESS_KEY, THEME_KEY, EMPTY_PROGRESS } = await fresh()
    expect(PROGRESS_KEY).toBe(KEY)
    expect(THEME_KEY).toBe(THEME)
    expect(EMPTY_PROGRESS).toEqual({ version: 1, updatedAt: '', checks: {}, read: {}, cards: {} })
  })
  it('does not touch localStorage when it loads', async () => {
    const getItem = vi.fn(() => null), setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: vi.fn() })
    await fresh()
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('parseProgress (import validation)', () => {
  it('accepts a valid export and keeps unknown ids', async () => {
    const { parseProgress } = await fresh()
    const text = JSON.stringify({ version: 1, updatedAt: '2026-10-25T10:00:00.000Z', checks: { 'w9:gone': true }, read: {}, cards: { 'x-q1': { box: 1, due: '2026-10-26' } }, extra: 1 })
    expect(parseProgress(text)).toEqual({ ok: true, progress: { version: 1, updatedAt: '2026-10-25T10:00:00.000Z', checks: { 'w9:gone': true }, read: {}, cards: { 'x-q1': { box: 1, due: '2026-10-26' } } } })
  })
  it('keeps lastVisited and every kind of card state', async () => {
    const { parseProgress } = await fresh()
    const progress = { ...stored, lastVisited: '/week/3/psql-indexes-6', cards: { a: { box: 0 }, b: { box: 2, due: '2026-10-28' }, c: { box: 3, due: '2026-11-01' } } }
    expect(parseProgress(JSON.stringify({ ...progress, extra: 1 }))).toEqual({ ok: true, progress })
  })
  it.each([
    ['not json', "This file isn't valid JSON."],
    [JSON.stringify({ version: 2 }), 'This progress file has version 2; this site reads version 1.'],
    [JSON.stringify({ version: 0 }), 'This progress file has version 0; this site reads version 1.'],
    [JSON.stringify([1, 2]), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: { a: 'yes' }, read: {}, cards: {} }), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: {}, read: {}, cards: { c: { box: 5 } } }), "This isn't a progress file from this site."],
    [JSON.stringify({ version: 1, updatedAt: '', checks: {}, read: {}, cards: { c: { box: 1 } } }), "This isn't a progress file from this site."],
  ])('rejects %s', async (text, error) => {
    const { parseProgress } = await fresh()
    expect(parseProgress(text)).toEqual({ ok: false, error })
  })
  it.each([
    ['null', 'null'],
    ['an object with no version', '{}'],
    ['a read value that is not true', withBase({ read: { a: false } })],
    ['one unticked value among ticked ones', withBase({ checks: { a: true, b: false } })],
    ['a checks list instead of a map', withBase({ checks: [] })],
    ['a missing cards map', withBase({ cards: undefined })],
    ['a non-string updatedAt', withBase({ updatedAt: 5 })],
    ['a missing updatedAt', withBase({ updatedAt: undefined })],
    ['a non-string lastVisited', withBase({ lastVisited: 7 })],
    ['a null lastVisited', withBase({ lastVisited: null })],
    ['a card that is not an object', withBase({ cards: { c: null } })],
    ['a box that is not a number', withBase({ cards: { c: { box: '1', due: '2026-10-26' } } })],
    ['a box below 0', withBase({ cards: { c: { box: -1 } } })],
    ['a box above 3, even with a due date', withBase({ cards: { c: { box: 4, due: '2026-10-26' } } })],
    ['one bad card among good ones', withBase({ cards: { good: { box: 0 }, bad: { box: 9 } } })],
    ['a due date in the wrong format', withBase({ cards: { c: { box: 2, due: '26/10/2026' } } })],
    ['a due date that is not a string', withBase({ cards: { c: { box: 2, due: 20261026 } } })],
  ])('rejects %s as not a progress file', async (_, text) => {
    const { parseProgress } = await fresh()
    expect(parseProgress(text)).toEqual({ ok: false, error: NOT_OURS })
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

  it('loads valid stored progress once, then serves the cache', async () => {
    const map = stubStorage({ [KEY]: JSON.stringify(stored) })
    const { getProgress } = await fresh()
    expect(getProgress()).toEqual(stored)
    map.set(KEY, withBase({ read: { other: true } }))
    expect(getProgress()).toEqual(stored)
  })
  it('returns the identical object until something changes it', async () => {
    stubStorage({ [KEY]: JSON.stringify(stored) })
    const { getProgress, update } = await fresh()
    const first = getProgress()
    expect(getProgress()).toBe(first)
    update(p => ({ ...p, read: {} }))
    const second = getProgress()
    expect(second).not.toBe(first)
    expect(getProgress()).toBe(second)
    expect(first.read).toEqual({ 'async-1': true }) // the old snapshot is never mutated
  })
  it.each([
    ['missing', {}, {}],
    ['blocked', {}, { get: true }],
    ['corrupt', { [KEY]: '{oops' }, {}],
  ])('returns the identical empty state when the stored value is %s', async (_, init, fail) => {
    stubStorage(init, fail)
    const { getProgress } = await fresh()
    expect(getProgress()).toBe(getProgress())
  })
  it('backs up a corrupt value once, and a stored file of another version too', async () => {
    const other = JSON.stringify({ version: 2 })
    const map = stubStorage({ [KEY]: other })
    const { getProgress } = await fresh()
    getProgress()
    getProgress()
    const backups = [...map.keys()].filter(k => k.startsWith(`${KEY}:backup-`))
    expect(backups).toHaveLength(1)
    expect(map.get(backups[0])).toBe(other)
  })
  it('replaces the corrupt value on the next write and keeps the backup', async () => {
    const map = stubStorage({ [KEY]: '{oops' })
    const { update } = await fresh()
    update(p => ({ ...p, read: { a: true } }))
    expect(JSON.parse(map.get(KEY)!).read).toEqual({ a: true })
    const backup = [...map.keys()].find(k => k.startsWith(`${KEY}:backup-`))
    expect(backup && map.get(backup)).toBe('{oops')
  })

  it('updates the stored progress, not an empty one', async () => {
    const map = stubStorage({ [KEY]: JSON.stringify(stored) })
    const { update } = await fresh()
    update(p => ({ ...p, checks: { ...p.checks, extra: true } }))
    expect(JSON.parse(map.get(KEY)!)).toMatchObject({ checks: { 'w9:gone': true, extra: true }, read: { 'async-1': true }, cards: stored.cards })
  })
  it('stamps updatedAt itself, whatever the change says', async () => {
    stubStorage()
    const { update, getProgress } = await fresh()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-25T10:00:00.000Z'))
    update(p => ({ ...p, updatedAt: 'chosen by the caller' }))
    expect(getProgress().updatedAt).toBe('2026-10-25T10:00:00.000Z')
  })
  it('replaceProgress replaces everything, stamps updatedAt, saves and notifies', async () => {
    const map = stubStorage({ [KEY]: JSON.stringify({ ...stored, lastVisited: '/week/3/old' }) })
    const { replaceProgress, getProgress, subscribe } = await fresh()
    const seen = vi.fn()
    subscribe(seen)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T08:00:00.000Z'))
    replaceProgress({ version: 1, updatedAt: '2020-01-01T00:00:00.000Z', checks: {}, read: { n: true }, cards: {} })
    const expected = { version: 1, updatedAt: '2026-10-26T08:00:00.000Z', checks: {}, read: { n: true }, cards: {} }
    expect(getProgress()).toEqual(expected)
    expect(getProgress()).not.toHaveProperty('lastVisited') // nothing of the old state survives
    expect(JSON.parse(map.get(KEY)!)).toEqual(expected)
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('stops notifying a listener once it unsubscribes', async () => {
    stubStorage()
    const { update, subscribe } = await fresh()
    const seen = vi.fn()
    const off = subscribe(seen)
    off()
    update(p => p)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('when saving fails', () => {
  it('tells subscribers, so the notice can show', async () => {
    stubStorage({}, { set: true })
    const { update, subscribe } = await fresh()
    const seen = vi.fn()
    subscribe(seen)
    update(p => ({ ...p, read: { a: true } }))
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('clears the flag when a later save works, and saves everything kept in memory', async () => {
    const fail = { set: true }
    const map = stubStorage({}, fail)
    const { update, isSaveFailed } = await fresh()
    expect(isSaveFailed()).toBe(false)
    update(p => ({ ...p, read: { a: true } }))
    expect(isSaveFailed()).toBe(true)
    fail.set = false
    update(p => ({ ...p, read: { ...p.read, b: true } }))
    expect(isSaveFailed()).toBe(false)
    expect(JSON.parse(map.get(KEY)!).read).toEqual({ a: true, b: true })
  })
  it('treats a missing localStorage (server rendering) like blocked storage', async () => {
    vi.stubGlobal('localStorage', undefined)
    const { getProgress, update, isSaveFailed, EMPTY_PROGRESS } = await fresh()
    expect(getProgress()).toEqual(EMPTY_PROGRESS)
    update(p => ({ ...p, checks: { a: true } }))
    expect(getProgress().checks).toEqual({ a: true })
    expect(isSaveFailed()).toBe(true)
  })
})

describe('other tabs (storage events)', () => {
  function stubWindow() {
    const handlers: ((e: { key: string | null }) => void)[] = []
    const addEventListener = vi.fn((type: string, handler: (e: { key: string | null }) => void) => { if (type === 'storage') handlers.push(handler) })
    vi.stubGlobal('window', { addEventListener })
    return { addEventListener, fire: (key: string | null) => handlers.forEach(h => h({ key })) }
  }
  it('attaches the storage listener once, on the first subscribe', async () => {
    const win = stubWindow()
    stubStorage()
    const { subscribe } = await fresh()
    expect(win.addEventListener).not.toHaveBeenCalled()
    subscribe(() => {})
    subscribe(() => {})
    expect(win.addEventListener).toHaveBeenCalledTimes(1)
    expect(win.addEventListener).toHaveBeenCalledWith('storage', expect.any(Function))
  })
  it('subscribes without a window (server rendering)', async () => {
    expect(typeof window).toBe('undefined') // vitest's node environment
    const { subscribe } = await fresh()
    expect(() => subscribe(() => {})()).not.toThrow()
  })
  it('re-reads and notifies when the progress key changes, ignores other keys', async () => {
    const map = stubStorage()
    const win = stubWindow()
    const { getProgress, subscribe } = await fresh()
    const seen = vi.fn()
    subscribe(seen)
    const before = getProgress()
    map.set(KEY, JSON.stringify(stored))
    win.fire('some-other-key')
    win.fire(THEME)
    expect(getProgress()).toBe(before)
    expect(seen).not.toHaveBeenCalled()
    win.fire(KEY)
    expect(getProgress()).toEqual(stored)
    expect(getProgress()).not.toBe(before)
    expect(seen).toHaveBeenCalledTimes(1)
  })
  it('re-reads and notifies when storage is cleared', async () => {
    const map = stubStorage({ [KEY]: JSON.stringify(stored) })
    const win = stubWindow()
    const { getProgress, subscribe, EMPTY_PROGRESS } = await fresh()
    const seen = vi.fn()
    subscribe(seen)
    expect(getProgress()).toEqual(stored)
    map.clear()
    win.fire(null)
    expect(getProgress()).toEqual(EMPTY_PROGRESS)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('hooks', () => {
  it('give the "unknown yet" snapshot while server rendering, even with progress stored', async () => {
    stubStorage({ [KEY]: JSON.stringify(stored) })
    const { useProgress, useSaveFailed } = await fresh()
    const Probe = () => createElement('p', null, `${String(useProgress())}|${String(useSaveFailed())}`)
    expect(renderToString(createElement(Probe))).toBe('<p>null|false</p>')
  })
})

describe('theme', () => {
  function stubDocument() {
    const dataset: Record<string, string> = {}
    vi.stubGlobal('document', { documentElement: { dataset } })
    return dataset
  }
  it('reads only a saved light or dark', async () => {
    const map = stubStorage()
    const { getTheme } = await fresh()
    expect(getTheme()).toBeNull()
    map.set(THEME, 'dark')
    expect(getTheme()).toBe('dark')
    map.set(THEME, 'light')
    expect(getTheme()).toBe('light')
    map.set(THEME, 'sepia')
    expect(getTheme()).toBeNull()
  })
  it('saves the choice and marks the page; null clears both', async () => {
    const map = stubStorage()
    const dataset = stubDocument()
    const { setTheme } = await fresh()
    setTheme('dark')
    expect(map.get(THEME)).toBe('dark')
    expect(dataset.theme).toBe('dark')
    setTheme(null)
    expect(map.has(THEME)).toBe(false)
    expect(dataset).not.toHaveProperty('theme')
  })
  it.each([
    ['full', () => stubStorage({}, { set: true })],
    ['blocked', () => stubStorage({}, { get: true, set: true })],
    ['missing', () => vi.stubGlobal('localStorage', undefined)],
  ])('still switches the page and never throws when storage is %s', async (_, stub) => {
    stub()
    const dataset = stubDocument()
    const { getTheme, setTheme } = await fresh()
    expect(() => setTheme('light')).not.toThrow()
    expect(dataset.theme).toBe('light')
    expect(() => setTheme(null)).not.toThrow()
    expect(dataset).not.toHaveProperty('theme')
    expect(getTheme()).toBeNull()
  })
})

describe('THEME_SCRIPT', () => {
  // Runs the script the way the browser would, against a fake localStorage and document.
  const run = (script: string, storage: object) => {
    const dataset: Record<string, string> = {}
    new Function('localStorage', 'document', script)(storage, { documentElement: { dataset } })
    return dataset
  }
  it('is the exact inline script', async () => {
    const { THEME_SCRIPT } = await fresh()
    expect(THEME_SCRIPT).toBe("try{var t=localStorage.getItem('backend-study:theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}")
  })
  it('applies a saved theme, ignores anything else, and survives blocked storage', async () => {
    const { THEME_SCRIPT } = await fresh()
    const storing = (value: string | null) => ({ getItem: (k: string) => (k === THEME ? value : null) })
    expect(run(THEME_SCRIPT, storing('dark'))).toEqual({ theme: 'dark' })
    expect(run(THEME_SCRIPT, storing('light'))).toEqual({ theme: 'light' })
    expect(run(THEME_SCRIPT, storing('sepia'))).toEqual({})
    expect(run(THEME_SCRIPT, storing(null))).toEqual({})
    expect(run(THEME_SCRIPT, { getItem: () => { throw new Error('blocked') } })).toEqual({})
  })
})
