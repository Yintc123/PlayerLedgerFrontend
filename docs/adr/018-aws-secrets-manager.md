# ADR 018 - AWS Secrets Manager 為 secret 儲存

## 狀態

已採用（為 [01-bff-architecture.md §11.4](../specs/01-bff-architecture.md#114-ecs-task-definition-樣板) 隱含的 secret 儲存決策補上正式 ADR）

## 背景

ECS Task Definition 內 `secrets` 區段引用的是 Secrets Manager ARN（spec 01 §11.4 範例），但 spec 沒有正式比對 SSM Parameter Store SecureString 與其他替代方案。Secret 儲存是高敏感、難回改的決策（rotate / IAM / 成本模型差異大），值得紀錄。

## 評估

### 候選方案

| 方案 | 自動 rotation | 加密 | 成本 | IAM 粒度 | ECS 整合 |
|------|--------------|------|------|---------|----------|
| **A. AWS Secrets Manager**（採用） | ✅ 原生支援 Lambda hook | KMS-CMK | $0.40/secret/月 + $0.05/萬次 API | 細到單一 secret ARN | 原生 `secrets:` 區段 |
| B. SSM Parameter Store SecureString | ❌ 無內建 rotation | KMS-CMK | 標準層免費（< 10k params） / Advanced $0.05/param/月 | 細到參數路徑 prefix | 原生 `secrets:` 區段 |
| C. HashiCorp Vault | ✅ 強，policy 細 | Vault internal | 自跑成本 + 維護 | RBAC | 需 sidecar / agent |
| D. K8s Secrets（不適用 ECS） | — | — | — | — | — |

### 為何挑 Secrets Manager

1. **自動 rotation（決定性差異）**：本專案 v1 的 secrets 含 `REDIS_PASSWORD`。雖 v1 未必排程 rotation，但接 RDS / 後端 JWT secret 後皆會需要；Secrets Manager 原生 schedule + 內建 RDS rotation Lambda，SSM 需自寫腳本。
2. **Resource policy（IAM 粒度）**：Secrets Manager 支援 secret-level resource policy，可寫「只有 ECS Task IAM role 能讀 / 只有 dev 環境角色能寫」；SSM Parameter Store 的 policy 是參數路徑 prefix-based，較粗糙。
3. **跨帳號 / 跨 region 複製**：Secrets Manager 支援 secret replica（DR 場景），SSM 沒有。
4. **與 RDS / DocumentDB / Redshift 等服務原生整合**：未來新增資料庫服務時自動 rotation 開箱即用。
5. **成本可控**：v1 僅少數 secret（REDIS_PASSWORD、未來的 JWT secret、未來的 DB credentials），預估 < 10 個；月費 < $5，不成阻力。

### Secrets Manager 的代價（已知接受）

- 比 SSM SecureString 月費高（v1 規模忽略不計）。
- API 呼叫計費，但 ECS 啟動時拉一次後在 process 內快取，每月 API 呼叫次數 = task 啟動次數 × secret 數，預估 < 100 次/月。

### 為何不採 SSM Parameter Store（方案 B）

| 對比情境 | 結論 |
|---------|------|
| 純設定值（如 `API_BASE_URL`、`CLIENT_ID`） | 仍走 ECS Task Definition `environment` 區段或 SSM Parameter Store（**非 secret** 沒必要進 Secrets Manager 浪費月費） |
| 真正的 secret（password / private key / token） | Secrets Manager。SSM SecureString 缺 rotation，且 v1 之後需求成長後遷移成本大 |

故 spec 維持「設定值用 env / SSM、secret 用 Secrets Manager」的雙軌策略，**本 ADR 只規範後者**。

### 為何不採 Vault（方案 C）

- 需自跑 cluster，違反「基礎設施簡單」原則（多一組要 patch / monitor 的服務）
- 對 v1 規模缺乏實質好處

## 決策

採 **AWS Secrets Manager** 儲存所有 secret，**非 secret 走 ECS env / SSM Parameter Store**：

### 規約

1. **進 Secrets Manager 的判定**：值若洩漏會造成「需要 rotate」或「資料外洩」級事故的，一律進 Secrets Manager。
   - `REDIS_PASSWORD` ✅
   - 未來 JWT secret ✅
   - 未來 DB credentials ✅
   - `API_BASE_URL`、`CLIENT_ID`、`PUBLIC_ORIGIN` ❌（屬於 config，env 即可）
2. **secret 命名規約**：`/playerledger-frontend/<env>/<secret-name>`，例 `/playerledger-frontend/production/redis-password`。Resource policy 寫於 secret 上，限制只有對應環境 task role 可讀。
3. **ECS 引用方式**：Task Definition `containerDefinitions[].secrets[].valueFrom` 填 Secrets Manager ARN；ECS agent 啟動時注入 env，BFF 程式讀到的就是純字串，不感知 secret backend。
4. **Rotation schedule**：v1 暫不啟用自動 rotation（流量小、攻擊面有限），但所有 secret 設 `rotation: false` 而非沒設定，文件化此決策。
5. **禁止把 secret 寫進 git**：CI / dev 環境用 `.env.example`（mask 過的 placeholder）+ 1Password / AWS CLI 拉 secret 本機開發；spec 04 `.dockerignore` 已禁止 `.env*` 進 image。

### 何時重新評估

- secret 數量成長到月費明顯（> $50/月）
- 需要進階功能 SSM 已能滿足（例 dynamic config + secret 統一管理）
- 切離 AWS 平台

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `docs/specs/01-bff-architecture.md` §11.4 | cross-ref 本 ADR；`secrets[]` 區段範例 |
| ECS Task Execution IAM Role | 需 `secretsmanager:GetSecretValue` 對特定 ARN 的權限 |
| Secrets Manager resource policy | 限制特定 task role 可讀 |
| `.env.example` | 列出需從 Secrets Manager 拉的 key 與 placeholder |

## 參考

- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)
- [SSM Parameter Store vs Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [Using secrets with ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html)
- [01-bff-architecture.md §11.4 ECS Task Definition](../specs/01-bff-architecture.md#114-ecs-task-definition-樣板)
