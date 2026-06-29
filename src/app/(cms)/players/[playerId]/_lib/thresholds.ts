/**
 * 玩家詳情頁業務門檻（spec 09 §4.3 / §9）。
 *
 * 退款率警示門檻：> 30% 由業務認定為異常。集中放此檔便於 PM 調整；
 * 長期可改由遠端 config 提供。
 */
export const REFUND_RATE_WARNING_THRESHOLD = 0.3;
