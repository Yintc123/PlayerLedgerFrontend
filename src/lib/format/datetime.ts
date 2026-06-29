/**
 * 時間格式化（spec 08 §5.1 / 09 §4.2 / 10 §5.1 / 11 §4.3）
 *
 * 資料層時間一律為 ISO 8601 UTC 字串；UI 層轉成顯示時區。
 *
 * **為何用固定 APP_TIME_ZONE 而非瀏覽器系統時區**：日期格式化在 Client Component
 * 內進行（會經 SSR + hydration）。若用系統時區，伺服器（多為 UTC）與瀏覽器（GMT+8）
 * 會算出不同字串 → React hydration mismatch 警告。本系統為單一地區內部 CMS，固定以
 * 台北時區顯示即等同「使用者時區」，且伺服器 / 客戶端輸出一致、無 hydration 問題。
 * 測試可傳入明確 timeZone 覆寫。
 */
export const APP_TIME_ZONE = 'Asia/Taipei';

type Parts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function getParts(iso: string, timeZone?: string): Parts {
  const date = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const lookup: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') lookup[p.type] = p.value;
  }
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour === '24' ? '00' : lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
  };
}

/** YYYY-MM-DD HH:mm（不顯示秒）。 */
export function formatDateTime(iso: string, timeZone: string = APP_TIME_ZONE): string {
  const p = getParts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD HH:mm:ss（含秒，明細頁用）。 */
export function formatDateTimeSeconds(iso: string, timeZone: string = APP_TIME_ZONE): string {
  const p = getParts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * 列表用簡短格式：本年顯示 MM-DD HH:mm；跨年顯示 YYYY-MM-DD HH:mm。
 * `now` 可注入以利測試；預設為目前時間。
 */
export function formatShortDateTime(
  iso: string,
  timeZone: string = APP_TIME_ZONE,
  now: Date = new Date()
): string {
  const p = getParts(iso, timeZone);
  const currentYear = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
  }).format(now);
  if (p.year === currentYear) {
    return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
