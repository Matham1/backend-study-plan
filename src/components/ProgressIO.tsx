'use client'

// Export and import of the saved progress (spec 7.7). Storage itself is src/lib/storage.ts; this is only the buttons.
import { useState, type ChangeEvent } from 'react'
import { today } from '../lib/progress'
import { getProgress, isSaveFailed, parseProgress, replaceProgress } from '../lib/storage'

/** Downloads the saved progress as `backend-study-progress-YYYY-MM-DD.json`. */
function exportProgress() {
  const blob = new Blob([JSON.stringify(getProgress(), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `backend-study-progress-${today()}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000) // later, not now: some browsers start the download after click() returns
}

export function ProgressIO() {
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ text: string; saved: boolean }>()

  /** Checks the chosen file, asks, and only then replaces the progress. A file that fails a check changes nothing. */
  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget // gone once this function has awaited
    const file = input.files?.[0]
    if (!file) return
    setError('')
    setDone(undefined)
    let text: string
    try {
      text = await file.text()
    } catch {
      setError("Couldn't read this file.")
      return
    } finally {
      input.value = '' // so choosing the same file again fires another change
    }
    const result = parseProgress(text)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // An export that was never changed has no save time (`updatedAt` is ''), and a hand-edited one may not hold a date.
    const savedAt = new Date(result.progress.updatedAt)
    const when = Number.isNaN(savedAt.getTime()) ? '' : ` (saved ${savedAt.toLocaleString()})`
    if (!confirm(`Replace the progress on this device with this file${when}? This can't be undone.`)) return
    replaceProgress(result.progress)
    const saved = !isSaveFailed()
    setDone({ saved, text: saved ? 'Progress imported.' : "Imported for this visit only: progress can't be saved in this browser." })
  }

  return (
    <div className="io">
      <p>
        <button type="button" className="btn primary" onClick={exportProgress}>
          Export progress
        </button>
      </p>
      <p>
        <label htmlFor="import-file">Import progress</label>
        <input id="import-file" type="file" accept=".json,application/json" onChange={importFile} />
      </p>
      {/* Both regions are always on the page, so their text is announced when it appears. */}
      <div role="alert">{error && <p className="notice">{error}</p>}</div>
      <div role="status">{done && <p className={done.saved ? 'notice ok' : 'notice'}>{done.text}</p>}</div>
    </div>
  )
}
