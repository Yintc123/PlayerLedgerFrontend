# ADR 008 - Token Refresh 等待者改用 bounded polling

## 狀態

已採用（修訂 ADR 004 步驟 5 的等待者實作；ADR 004 採用 Redis Mutex 的核心決策仍然成立）

## 背景

ADR 004 / spec 02 §3.4 原本的等待者邏輯只 sleep 一次 100ms,然後查一次 session 就決定回傳：

```
5. 【等待者】await sleep(100ms) → GET session
   ├─ 存在 → return accessToken
   └─ 不存在 → return null
```

這個設計隱含一個假設：**持鎖者的 `POST /auth/refresh` 一定在 100ms 內完成**。

實際 production 環境下,refresh 端點延遲分布（API Gateway + Lambda）：

| 百分位 | 延遲 | 主要因素 |
|--------|------|---------|
| p50 | ~80ms | VPC 內 Lambda 暖啟動 |
| p95 | 200-500ms | 中等負載、偶發冷啟動 |
| p99 | 1-3s | 多次冷啟動、區域延遲、後端 DB 壓力 |

100ms 只能覆蓋 p50 以下。**p50 之上的請求醒來時 session 仍未更新,於是 return null → 使用者被誤判登出。這不是邊緣案例,是 p50 線上的事件。**

更糟的是,這類失敗在 dev 環境幾乎重現不出來（手動操作一次一個請求,且本地 refresh 通常 < 10ms）,只在 production 同時發生多請求時冒出來,debug 困難。

## 評估

### 方案 A：加大固定 sleep 到 1-2 秒

```
await sleep(2000)
GET session
```

**缺點：** 99% 情況（refresh 在 100ms 內完成）平白多等 1900ms,使用者明顯感受變慢。仍無法覆蓋 p99 的 3 秒。

### 方案 B：Bounded polling（採用）

每 100ms 輪詢 session 一次,直到三個終止條件之一：

```
const startedAt = Date.now()
const maxWaitMs = (REFRESH_LOCK_TTL_SECONDS - 1) * 1000  // 9000ms

while (Date.now() - startedAt < maxWaitMs):
  await sleep(100)
  current = await GET session:<sid>
  if (!current) return null                                              // 被刪
  if (current.accessToken !== original.accessToken) return current.accessToken  // 已更新
  // 否則繼續輪詢

return null  // 超過 max wait
```

**優點：**
- 快速 refresh（< 100ms）走第一輪 poll 就拿到,延遲與原設計相同
- 慢速 refresh（500ms-3s）多 poll 幾輪也能拿到結果,**消除 p50-p99 區間的誤登出**
- 上限與 lock TTL 對齊,有 1 秒安全邊距
- 持鎖者 crash 時 lock 在 10s TTL 後自動失效,下個請求重新搶鎖

**缺點：**
- 慢路徑下 Redis QPS 略增（最多 90 次 / 9 秒 / waiter）。ElastiCache 同 VPC < 1ms / 次,不重要

### 方案 C：Exponential backoff

```
await sleep(50) → 100 → 200 → 400 → ...
```

**缺點：** refresh 延遲是有界的（lock TTL = 10s）,exponential 沒有顯著好處,反而讓「慢但接近完成」的場景多等冤枉時間（例如 refresh 在 1.6s 完成,exponential 下一輪是 3.2s 才查）。可讀性也較差。

### 方案 D：Redis Pub/Sub 推送通知

持鎖者 refresh 完成後 publish 訊息,等待者 subscribe 並等通知,完全免輪詢。

**缺點：**
- 每個 waiter 都要起一條 subscription,連線管理變複雜
- subscriber miss timing 的 race condition 需另外處理（subscribe 前訊息已發出）
- failure mode 增多（連線斷、訊息漏）

只在 polling 確實成為瓶頸時才考慮。本專案規模下,方案 B 的 Redis 開銷可忽略,不需要 D。

## 決策

採用**方案 B（bounded polling）**。

| 參數 | 值 | 來源 |
|------|-----|------|
| Poll interval | 100ms 固定 | 程式碼常數,不開 env var |
| Max wait | `(REFRESH_LOCK_TTL_SECONDS - 1) * 1000` | 自現有 env var 推導,預設 9000ms |
| 終止條件 | session 被刪 / `accessToken` 改變 / 達 max wait | — |

### 為何用 `accessToken` 差異判斷「已更新」而非 `expiresAt`

- `expiresAt` 在某些後端可能因時鐘漂移、整數秒截斷而短期持平
- `accessToken` 在 refresh 後**必然不同**（即使 RT rotation 關閉,AT 也會換發）,是最可靠的「已更新」訊號
- 比較字串相等是 O(token length),成本可忽略

### 為何 max wait 推導自 lock TTL 而非獨立 env var

- 兩值有強耦合關係：waiter 等待時間 > lock TTL 沒有意義（lock 已超時的話下個請求會重新搶鎖,當前 waiter 繼續等只會 false negative）
- 各自獨立會出現配置不一致：例如 lock TTL = 5s 但 wait timeout = 10s,後 5s 的等待沒有任何理論依據
- 留 1 秒安全邊距,避免 wait 與 lock 在同一毫秒到期的邊界 case

### 為何 poll interval 不開 env var

- 100ms 是長期經驗值（人類感知延遲門檻 ≈ 100ms,Redis QPS 也在合理範圍）
- 開放成 env var 會誘導未來工程師「調看看會不會比較快」,引入隨機調參而非有依據的 tuning
- 真要調的話直接改常數重新部署即可,使用頻率極低

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` §3.4 | 演算法步驟 7 改寫為 bounded polling,加 3 條補充說明,時序圖標註「快路徑」並補慢路徑文字描述,Refresh 失敗處理多列一條「等待者超過 max wait」case |
| `docs/adr/004-token-refresh-mutex.md` | 開頭加修訂註記指向本 ADR,核心決策不變 |

## 參考

- AWS Lambda cold start 統計：暖啟動 < 100ms,冷啟動 200ms-3s（取決於 runtime、VPC、code size）
- Node.js `setTimeout` 在 Event Loop 中是非阻塞的,polling 期間 process 可以正常處理其他請求（不會卡住整個伺服器,詳見 ADR 004 §「為何等待者可以 await sleep 而不阻塞伺服器」）
