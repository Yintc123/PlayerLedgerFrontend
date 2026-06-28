# PlayerLedger Frontend — Claude Guidelines

## 開發方法：TDD

本專案嚴格遵守 **Test-Driven Development**，開發任何功能前必須先寫測試。

### TDD 流程

```
1. Red   — 寫一個失敗的測試，明確描述預期行為
2. Green — 寫最少量的程式碼讓測試通過
3. Refactor — 在測試保護下重構，不改變行為
```

### 規則

- **不允許在沒有對應測試的情況下新增功能程式碼**
- 測試檔案與實作檔案放在同一目錄，命名為 `*.test.ts` 或 `*.spec.ts`
- 每個測試只驗證一件事，測試名稱清楚描述行為（`it('should ...')`）
- UI 元件使用 React Testing Library，測試使用者行為而非實作細節
- 不 mock 內部模組，只 mock 外部依賴（API、瀏覽器 API）

### 測試命名以 spec 為準

測試清單已在對應 spec 寫好（`docs/specs/01-bff-architecture.md §6.4 / §9.5`、`docs/specs/02-auth-session.md §9`、`docs/specs/03-observability.md §6`）。實作時：

1. 先讀對應 spec 的測試清單
2. 依清單建立失敗測試（Red）
3. 實作最少程式碼讓測試通過（Green）
4. spec 沒列的測試代表設計階段未要求，新增前先評估是否該回頭更新 spec

避免「測試與 spec 不同步」——這是 SDD + TDD 結合的核心紀律。

### 測試分層

| 層級      | 工具                  | 涵蓋範圍                |
| --------- | --------------------- | ----------------------- |
| Unit      | Vitest                | 工具函式、hooks、純邏輯 |
| Component | React Testing Library | UI 元件互動行為         |
| E2E       | Playwright            | 關鍵使用者流程          |

### 執行測試

```bash
npm run test          # 單次執行
npm run test:watch    # 監聽模式（開發時使用）
npm run test:e2e      # E2E 測試
```

## 開發方法：SDD

API 串接以 OpenAPI Schema 為唯一契約：

- 不允許直接對 API 進行猜測性呼叫，所有 request/response 型別從 Schema 產生
- Schema 變更需先更新 `schema/` 目錄，再重新產生型別，最後調整實作
