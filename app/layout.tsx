import type { Metadata } from 'next'
import './globals.css'

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
      <body>{children}</body>
    </html>
  )
}
