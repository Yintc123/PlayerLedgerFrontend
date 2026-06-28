/**
 * Next.js instrumentation hook（Next.js 16 約定檔名）
 *
 * Next 16 同時呼叫 register() 在 nodejs 與 edge runtime；Edge bundler 會嘗試
 * 編譯整個檔案、警告 Node-only API。所以此檔只做 runtime 分流，實際工作放在
 * instrumentation-node.ts 由 dynamic import 載入，Edge bundle 永遠看不到。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
