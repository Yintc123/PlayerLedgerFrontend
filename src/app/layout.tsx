import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PlayerLedger',
  description: 'Player Ledger Frontend - BFF Architecture with Next.js 16',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading x-nonce triggers Next.js to inject the per-request nonce into its
  // generated inline <script> tags, satisfying the nonce-based CSP set by middleware.
  await headers();

  return (
    <html lang="zh-TW" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
