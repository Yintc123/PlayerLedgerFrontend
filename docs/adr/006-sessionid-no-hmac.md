# ADR 006 - SessionId 不採用 HMAC 簽章

## 狀態

已採用（修訂 ADR 003 中與 HMAC 驗證相關的描述；ADR 003 的函式拆分決策仍然成立）

## 背景

spec 02 §2.1 的 SessionId 設計原訂為：

```
sessionId = HMAC-SHA256(secret, random_bytes_32) → 64 個 hex 字元
```

並描述「驗證時重新計算 HMAC 防止偽造」。但 HMAC 驗證的前提是驗證方手上同時握有 `message` 與 `tag`，重算 `HMAC(secret, message)` 後與 `tag` 比對。

本設計把 `random_bytes_32`（message）丟棄，只把 HMAC 輸出（tag）存入 Cookie。後續請求拿回的 sid 等於 tag，沒有 message 可以重算——「驗證 HMAC 防偽造」這一步**在物理上做不到**。實際安全性完全來自 `GET session:<sid>` 的 Redis lookup，HMAC 與 `SESSION_SECRET` 形同擺設。

## 評估

### 方案 A：純 random opaque sid

```ts
const sid = crypto.randomBytes(32).toString('hex')   // 64 chars
```

- 驗證：格式正則 pre-filter + `GET session:<sid>` Redis lookup
- 安全強度：256 bits 隨機，遠超 OWASP 建議的 ≥64 bits
- 偽造一個能通過 Redis lookup 的 sid 等同猜中 256 bits 隨機值

**優點：**
- 簡單，少一個 secret 要管理
- 跟 express-session、Django、Rails、Spring Session、ASP.NET Core 等主流框架一致
- secret rotation 不影響既有 session

**缺點：**
- 偽造 sid 會打到 Redis 一次（< 1ms，可忽略）

### 方案 B：簽章式 sid（random + HMAC 拼接）

```
sid = `${random_hex}.${HMAC(secret, random_hex)}`   // ~129 chars
```

- 驗證：拆 `.` → 重算 HMAC timing-safe 比對 → 通過才 `GET session:<random>`
- 偽造的 sid 在 HMAC 比對就被擋掉，不會打到 Redis（DoS 緩解）

**優點：**
- Pre-Redis filter 阻擋偽造請求

**缺點：**
- Cookie 長度倍增
- `SESSION_SECRET` 真的要當機密管理，輪替需要過渡期同時驗新舊 secret
- 對 PlayerLedger 沒有實質收益（流量先過 CloudFront + API Gateway，DoS 不缺這層）

### 方案 C：維持原設計 `HMAC(secret, random)`

如背景所述，無法真正驗證。

**缺點：**
- HMAC 在此架構無實質作用
- 給人「有 HMAC 防護」的安全錯覺，code review 時可能誤判通過
- secret 看似在用但實際沒被驗到，rotation 流程也跟著虛設

## 決策

採用**方案 A**：sid 為 `crypto.randomBytes(32).toString('hex')` 的 64 字元隨機字串，不做 HMAC 簽章。

### 驗證流程

```
1. (await cookies()).get('sid')?.value
   └─ 不存在 → return null

2. isWellFormed(sid)（/^[0-9a-f]{64}$/）
   └─ 格式不合 → return null（不打 Redis，省成本）

3. GET session:<sid>
   └─ 不存在 → return null
   └─ 存在   → SessionData
```

格式正則是廉價 pre-filter：擋掉明顯亂打的 sid，避免無意義的 Redis 呼叫。它不是密碼學驗證——真正的把關在 Redis lookup。

### 何時改採方案 B

若未來出現下列任一情境，再評估改採方案 B：

- 流量不再經過 CDN / API Gateway，sid 端點直接暴露於公網
- 出現針對 session lookup 的 DoS 攻擊（Redis QPS 異常飆高）
- 合規要求 cookie 必須帶整體完整性簽章

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` | §2.1 SessionId 定義、§3.4 演算法步驟 2、§3.5 函式表、§4 `proxy.ts` 保護邏輯、§9 測試名稱 |
| `docs/specs/01-bff-architecture.md` | §5 移除 `SESSION_SECRET` env、§6.2 移除 `validateSessionSecret` 與 `session.secret` 欄位、§6.3 模組對照表、§6.4 移除 3 個 SESSION_SECRET 測試、§7.4 CI 移除 SESSION_SECRET env、§7.5 移除 `E2E_SESSION_SECRET` secret |
| `.env.example` | 移除整個 SESSION_SECRET 區塊 |
| `ADR 003` | HMAC 驗證描述被本 ADR 修訂，函式拆分決策仍然成立 |

## 參考

- OWASP Session Management Cheat Sheet：建議 session id 至少 64 bits entropy，本設計提供 256 bits
- express-session（`uid-safe(24)`）、Django（`get_random_string`）、Rails CacheStore（`SecureRandom.hex(32)`）、Spring Session（`UUID.randomUUID()`）均採方案 A
