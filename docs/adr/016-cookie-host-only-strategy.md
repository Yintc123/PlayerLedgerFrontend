# ADR 016 - Session Cookie 採 Host-only `__Host-` prefix

## 狀態

已採用（為 [02-auth-session.md §2.4](../specs/02-auth-session.md#24-cookie-設定) 隱含的安全決策補上正式 ADR）

## 背景

spec 02 §2.4 規定 session cookie name 為 `__Host-sid`（production）、`Domain` 屬性留空——這是一個重要的安全決策（限縮 cookie scope 至 origin host），但 spec 中只以說明文字呈現，沒有 ADR 紀錄替代方案的權衡。未來若有人因 SSO 或子網域共享需求要改 cookie scope，可能會誤把 `__Host-` 改掉 / 加 `Domain=.playerledger.com`，無聲降低安全姿勢。

## 評估

### 候選方案

| 方案 | Cookie 範圍 | 風險 |
|------|------------|------|
| **A. `__Host-sid`，不設 `Domain`**（採用） | 完全限定發行 host，所有子網域**讀不到** | 子網域不能共享 session |
| B. `sid`，不設 `Domain` | host-only 但無瀏覽器強制（`__Host-` 拒絕 `Domain` 也拒絕無 `Secure` 的 cookie） | 攻擊者透過 cookie injection 漏洞可塞同名 cookie（無強制檢查） |
| C. `sid`，`Domain=.playerledger.com` | 所有子網域共享 session | 任一子網域 XSS 全公司 sid 外洩；新加子網域時要審核 cookie scope |
| D. `sid`，`Domain=app.playerledger.com` 等具體子網域 | 限定該子網域 + 其下層 | 比 C 安全，但仍需逐子網域核可 |

### 為何挑 A（`__Host-` + 無 Domain）

1. **瀏覽器強制三項屬性**：RFC 6265bis §4.1.3 規定帶 `__Host-` prefix 的 cookie 必須同時滿足 `Secure` + `Path=/` + 無 `Domain`；任一不符合會被瀏覽器**直接丟棄**。這把「安全姿勢」從應用程式檢查變成瀏覽器強制檢查，繞不過。
2. **杜絕 cookie injection**：攻擊者透過子網域漏洞嘗試寫一個同名 cookie 帶 `Domain=.playerledger.com`，瀏覽器會因 `__Host-` 規則拒絕——這是「子網域不可信」威脅模型下的 hardening（OWASP ASVS 3.4.5）。
3. **本應用無多子網域共享需求**：v1 的 CMS 與公開頁面都在同一個 origin（`playerledger.com`）下；未來若加入 admin 子網域等，會需要顯式評估，避免「隱性擴大 cookie scope」。
4. **與 spec 02 §6.2 session fixation 防護互補**：login 強制 regenerate sid（DEL 舊 key、SET 新 key），即使攻擊者預植 sid，受害者登入後也會被換掉；`__Host-` 是另一層防線（攻擊者根本送不出有效預植 cookie）。

### A 的代價（已知接受）

- 不支援跨子網域 SSO 場景。若未來有需要：必須走 ADR 修訂 + 換名（不能用 `__Host-`）+ 設具體 `Domain` + 更新威脅模型。
- dev 環境因 `__Host-` 要求 HTTPS，本機 HTTP 無法用該 prefix；spec 02 §2.4 註明 dev 用 `sid`（無 prefix），由 `SESSION_COOKIE_NAME` 常數依環境切換。

### 為何不採 B（純 host-only 無 prefix）

`__Host-` 提供的是**瀏覽器強制檢查**；B 等於把同樣的規則改成「應用程式自我克制」，但程式碼 review 或日後改動容易疏漏。攻擊者送出帶 `Domain=` 的同名 cookie 時，瀏覽器仍會接受 → 應用層讀到「兩個 cookie 同名」時行為不可預期（部分框架取第一個、部分取最後一個）。`__Host-` 把整類問題從根本消除。

## 決策

採方案 A：

1. **production**：cookie name = `__Host-sid`、`Path=/`、`Secure`、`HttpOnly`、`SameSite=Lax`、**不設 `Domain`**、不設 `Partitioned`。
2. **dev**：cookie name = `sid`（無 prefix），其餘屬性同上但 `Secure=false`（本機 HTTP 適用）。
3. 程式內**禁止硬編 `'sid'` / `'__Host-sid'`**：必須從 `lib/session/cookie.ts` 匯入 `SESSION_COOKIE_NAME` 常數（spec 02 §2.4 / B4 已修補殘留）。
4. **`COOKIE_DOMAIN` env 預設留空**；填值會自動失去 `__Host-` 資格（程式碼需在 production 環境警告 / 拒絕同時設定）。
5. 啟用 `__Host-` 後 cookie 大小受瀏覽器規範限制（多數瀏覽器 4KB / cookie），目前 sid 為 64-char hex 字串，遠低於上限。

### 何時重新評估

- 業務真的需要跨子網域共享 session（SSO / admin 子網域）
- 出現 `__Host-` 在主流瀏覽器不再被強制檢查的迴歸
- 規範升級到新版（RFC 6265bis 正式發布且行為差異）

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/02-auth-session.md` §2.4 / §6.2 | cross-ref 本 ADR |
| `lib/session/cookie.ts` | 唯一定義 `SESSION_COOKIE_NAME`、cookie attribute 組裝 |
| `proxy.ts`、`lib/auth/login.ts`、`lib/auth/logout.ts`、`getValidAccessToken` | 一律使用常數，不硬編 |
| `docs/specs/01-bff-architecture.md` §5 | `COOKIE_DOMAIN` env 說明對齊「預設留空、設值即降級」 |

## 參考

- [RFC 6265bis §4.1.3 Cookie Prefixes](https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-13.html#name-cookie-prefixes)
- [OWASP ASVS V3.4 Cookie-based Session Management](https://owasp.org/www-project-application-security-verification-standard/)
- [02-auth-session.md §2.4 Cookie 設定](../specs/02-auth-session.md#24-cookie-設定)
- [ADR 006 — sessionid 不採 HMAC](./006-sessionid-no-hmac.md)（與本 ADR 共同構成 sid 端到端設計）
