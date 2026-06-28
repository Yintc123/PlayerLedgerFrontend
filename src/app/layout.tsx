import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PlayerLedger',
  description: 'Player Ledger Frontend - BFF Architecture with Next.js 16',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  )
}
