import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { THEME_SCRIPT } from '../lib/storage'
import './globals.css'

export const metadata: Metadata = {
  title: { template: '%s · Backend Study Plan', default: 'Backend Study Plan' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <header>
          <Link href="/">Backend Study Plan</Link>
          <nav>
            <Link href="/">Dashboard</Link> <Link href="/review">Review</Link> <Link href="/capstone">Capstone</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
