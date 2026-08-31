import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Research Summarizer Graph',
  description: 'Multi-node LangGraph workflow: read_source → summarize → fact_check ↺',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen text-neutral-200 antialiased">{children}</body>
    </html>
  )
}
