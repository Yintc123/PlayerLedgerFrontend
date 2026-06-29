/**
 * 金額格式化（對齊後端 deposit-records-model §1）。
 *
 * 金額在資料層一律以「該幣別最小單位」整數傳遞，但**後端對最小單位的定義不完全等於
 * ISO 4217**：TWD → 元（0 位小數，1000 元 = 1000）、USD → cent（2 位，$10.50 = 1050）、
 * JPY → 円（0 位，500 円 = 500）。因此 minor digits 以「後端定義」為準：先查 override，
 * 其餘 fall back 至 ICU（Intl）。
 */

const DEFAULT_LOCALE = 'zh-TW';

// 後端對「最小單位」的定義覆寫（與 ISO 不同處）。TWD 後端視為 0 位（元），非 ISO 的 2 位。
const BACKEND_MINOR_DIGITS: Record<string, number> = {
  TWD: 0,
};

function isoMinorDigits(currency: string): number {
  try {
    const opts = new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency,
    }).resolvedOptions();
    return opts.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** 取得某幣別在後端語意下的最小單位位數（TWD=0、USD=2、JPY=0）。 */
export function currencyMinorDigits(currency: string): number {
  return BACKEND_MINOR_DIGITS[currency] ?? isoMinorDigits(currency);
}

/**
 * 將最小貨幣單位整數格式化為含幣別的字串。
 * 例：formatAmount(1000, 'TWD') → "NT$1,000"；formatAmount(1050, 'USD') → "US$10.50"
 */
export function formatAmount(
  amountMinor: number,
  currency: string,
  locale: string = DEFAULT_LOCALE
): string {
  const digits = currencyMinorDigits(currency);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

/** 退款率（後端回傳之比例，如 0.0523）格式化為百分比字串。 */
export function formatRefundRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}
