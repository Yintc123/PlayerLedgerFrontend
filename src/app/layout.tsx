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
    // suppressHydrationWarning（僅作用於 <html> 自身屬性，一層淺層）：
    // 瀏覽器翻譯外掛 / 「翻譯此頁」會在 React hydrate 前改寫 <html lang>（zh-TW → 使用者
    // 介面語言如 en），造成無害的 hydration 屬性不符警告。抑制此單一元素的警告即可，
    // 不影響子樹其他真正的 mismatch 偵測。
    <html lang="zh-TW" className={inter.variable} suppressHydrationWarning>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
