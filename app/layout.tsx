import type { Metadata } from 'next'
import './globals.css'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'PDF-Bench — PDF Text Extraction Benchmarking',
  description:
    'Production benchmarking platform for comparing PDF text extraction engines. ' +
    'Measures CER, WER, reading-order accuracy, numeric fidelity, and composite score.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <header>
          <div className="container inner" style={{ justifyContent: 'space-between' }}>
            <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h1 style={{ margin: 0 }}>HuntForTomorrow</h1>
              <div className="subtitle" style={{ marginTop: '4px' }}>PDF Text Extraction Benchmarking System</div>
            </Link>
            <div style={{ display: 'flex', gap: '12px' }}>
              <Link href="/approaches" className="btn btn-secondary btn-sm">
                Approach & Pricing
              </Link>
              <Link href="/review" id="review-queue-link" className="btn btn-secondary btn-sm">
                ✎ GT Review Queue
              </Link>
            </div>
          </div>
        </header>
        {children}
      </body>
    </html>
  )
}
