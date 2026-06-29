# OpenAPI Schema

`openapi.yaml` 是前端串接後端 API 的**唯一契約**（SDD，見 `docs/specs/01-bff-architecture.md §4.3`）。

## 單一可信來源

此檔案是從後端 repo **同步複製**而來，後端為唯一可信來源（single source of truth）：

```
PlayerLedgerBackend/schema/openapi.yaml  →  src/schema/openapi.yaml
```

**請勿在前端手動編輯。** 後端契約變更時，於後端更新 `schema/openapi.yaml`（後端有 `openapi_validate_test.go` 驗證），再重新同步到前端。

## Re-sync

```bash
# 從 frontend repo 根目錄執行
cp ../PlayerLedgerBackend/schema/openapi.yaml src/schema/openapi.yaml
diff -q ../PlayerLedgerBackend/schema/openapi.yaml src/schema/openapi.yaml   # 應無輸出
```

## 型別產生

本專案資料層慣例為**手寫 `Raw*` shape + camelCase transform**（見 `docs/specs/05 §99`），
v1 **不**啟用 `openapi-typescript` codegen 與 `schema-check` CI（見 `docs/specs/01 §8.6`）。
此 schema 目前作為契約對照用；待後端契約完全穩定後再依 spec 啟用自動產生型別。
