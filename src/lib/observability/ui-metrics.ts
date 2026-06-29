/**
 * 輕量畫面層 metric 發送（spec 03 §6 對接點）。
 *
 * Mock 階段為 no-op（dev 時印 debug）；真實版會接 EMF / OTel counter。
 * 抽成獨立模組讓頁面測試可 spy `recordMetric`。
 */
export function recordMetric(name: string, tags: Record<string, string | number> = {}): void {
  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.debug('[metric]', name, tags);
  }
}
