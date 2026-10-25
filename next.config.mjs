import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants.js'

// Velite's Next.js setup: build the content (and watch it in dev) before Next compiles. Velite's docs check
// process.argv for "dev", which misses Next 16's dev server: it is a forked process with no "dev" in its argv.
// Next's telemetry flush (detached-flush.js, run after `next dev` exits) does have "dev" and loads this file in
// the dev phase, and a watcher would keep it alive forever. So this keys on the phase and skips that process.
// VELITE_STARTED keeps processes that inherit it (the build workers) from building again.
/** @type {(phase: string) => Promise<import('next').NextConfig>} */
export default async phase => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER && !process.argv[1]?.includes('detached-flush')
  if (!process.env.VELITE_STARTED && (isDev || phase === PHASE_PRODUCTION_BUILD)) {
    process.env.VELITE_STARTED = '1'
    await (await import('velite')).build({ watch: isDev, clean: !isDev })
  }
  return {
    output: 'export',
    trailingSlash: true,
    basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  }
}
