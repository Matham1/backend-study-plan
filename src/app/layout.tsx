import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ThemeToggle } from '../components/chrome'
import { THEME_SCRIPT } from '../lib/storage'
import './globals.css'

export const metadata: Metadata = {
  title: { template: '%s · Backend Study Plan', default: 'Backend Study Plan' },
}

// Each page wraps itself in <DocLayout> (the sidebar differs per page), and that is where <main> is.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              Backend Study Plan
            </Link>
            <nav aria-label="Main">
              <Link href="/">Dashboard</Link>
              <Link href="/review">Review</Link>
              <Link href="/capstone">Capstone</Link>
            </nav>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  )
}
