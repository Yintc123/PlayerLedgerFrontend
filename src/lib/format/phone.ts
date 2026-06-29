/**
 * 手機顯示格式化（spec 08 §5.1 / 09 §4.2）
 *
 * E.164 值（如 +886912345678）僅在「顯示」時加空白分組，方便閱讀。
 * **不可** 變更送往後端 / API 的原始值——本函式純粹回傳展示字串。
 * 遮罩值（含 `*`，如 `****5678`）原樣回傳，不嘗試分組。
 */
export function formatPhoneForDisplay(phone: string): string {
  // 遮罩值原樣顯示
  if (phone.includes('*')) return phone;

  const match = /^\+(\d{1,3})(\d+)$/.exec(phone.trim());
  if (!match) return phone;

  const [, country, rest] = match;
  // 將 rest 以 3 碼為一組分隔
  const groups = rest.match(/\d{1,3}/g) ?? [rest];
  return `+${country} ${groups.join(' ')}`;
}
