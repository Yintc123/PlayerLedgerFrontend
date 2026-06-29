# Dockerfile 與 Build 規格書

## 1. 設計原則

| 原則 | 體現 |
|------|------|
| **最小化 image 大小** | multi-stage build + Next.js `output: 'standalone'` + alpine base |
| **最小化 attack surface** | 非 root user、無 shell 包(distroless 候選)、僅必要 runtime、ECS Task 設定 read-only root fs + drop ALL capabilities + `no-new-privileges` |
| **可重現 build** | `npm ci` 而非 `npm install`、base image 以 `@sha256:` digest 釘版（純 tag 會隨 mutable rebuild 漂移） |
| **快速啟動** | 預先 copy 必要檔案、避免啟動時的解壓 / 編譯 |
| **CI / CD 友善** | 善用 BuildKit cache、layer 順序由「最不常變」到「最常變」、build 時產出 SBOM 與 provenance attestation |
| **健康可檢測** | HEALTHCHECK 指令對應 spec 01 §9.1 的 liveness `/api/health`（只證明 process 活著，不含 Redis；ADR 022），path / port 來自 ENV 不寫死 |
| **優雅關閉** | `tini` 當 PID 1 收割殭屍、轉送 SIGTERM；Next.js standalone server 內收到 SIGTERM 後須等 in-flight 請求結束才退出，避免 ECS rolling deploy 砍斷使用者請求（詳見 §3.6） |

---

## 2. Next.js Standalone Output

啟用 `next.config.ts` 的 `output: 'standalone'`：

```ts
// next.config.ts
const config: NextConfig = {
  output: 'standalone',
  // ...
}
```

此設定讓 `next build` 額外產生 `.next/standalone/` 目錄,內含：
- 一個極簡的 `server.js` 啟動腳本
- 僅包含 production runtime 必要的 `node_modules`(只有實際被 import 的依賴,經過 tree shaking)

效果：image 內 `node_modules` 從原本 ~400MB 降到 ~100MB。

---

## 3. Dockerfile

```dockerfile
# syntax=docker/dockerfile:1.7

# =============================================================================
# Base image：以 @sha256 digest 釘版（標籤是可變指標，會被同名 rebuild 覆蓋）
# 初次安裝 / 升級流程：見 §3.3.1「Base image SHA bootstrap」
# CI 應定期 dependabot 自動 PR；版本變化視同程式變更走完 CI/CD。
# =============================================================================
ARG NODE_IMAGE=node:22-alpine@sha256:REPLACE_WITH_PINNED_DIGEST

# =============================================================================
# Stage 1: Dependencies
# 只裝 production deps,獨立 layer 讓 cache 可重用
# =============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# 安裝 build 需要的系統套件（libc6-compat 是某些 npm 套件的 native binding 依賴）
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev


# =============================================================================
# Stage 2: Builder
# 完整 dev deps + 跑 build
# =============================================================================
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

# build 時注入版本資訊,讓執行階段可讀
# 注意：APP_VERSION 必填，CI 須於 build-push-action 傳 --build-arg APP_VERSION=<tag>
# 若預設值 'unknown' 走到 production，CI smoke test（§5.2）會擋住 deploy
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build


# =============================================================================
# Stage 3: Runner
# 最小化 runtime,只含 standalone server + static assets + tini
# =============================================================================
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Node heap 上限應略小於 ECS Task memory，避免在容器 hard limit 觸發前 Node 自我 GC
# 例：task memory 1024MB → 800MB；512MB → 400MB；由 ECS Task Definition 對應調整
ENV NODE_OPTIONS="--max-old-space-size=800"

# 建立非 root 使用者,UID/GID 用固定數字避免 host volume mount 權限問題
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# tini：PID 1 收割殭屍 + 轉送 SIGTERM 給 Node.js；wget 用於 HEALTHCHECK（alpine 內建 busybox wget）
# 不裝 curl —— busybox wget 已足夠且不引入額外 CVE 面
RUN apk add --no-cache tini

# 複製 standalone server（已含必要 node_modules）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# 複製靜態檔案（standalone 不會自動複製這兩個目錄）
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

# HEALTHCHECK 對應 spec 01 §9.1 的 liveness /api/health（不含 Redis；ADR 022）
# CMD 為 shell 形式（無 JSON 陣列），${PORT} 會在 runtime 由 /bin/sh 展開，
# 因此 ECS Task 改 PORT env 不會讓健康檢查靜默壞掉
# 注意：ECS Target Group 同時做 L7 health check（spec 01 §9.4），這層是 docker 層保險
#
# 為何不用 `wget --spider`：busybox wget --spider 在 HTTP 4xx 仍 exit 0
# （只在 transport 錯誤 / 5xx 失敗），路由失誤導致 /api/health 變 404 時假綠燈。
# 改為下載 body 並 grep `"status":"ok"`，配合 BFF 端 §9.1 liveness 的 shape 一致。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q -O- "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
        | grep -q '"status":"ok"' || exit 1

# tini 處理 PID 1 行為：收割殭屍 + 轉送訊號（SIGTERM/SIGINT）給 Node.js
# Node 收 SIGTERM 後須完成 in-flight 請求才退出，詳見 §3.6
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
```

### 3.1 Stage 設計理由

| Stage | 為何分離 |
|-------|---------|
| `deps` | 只裝 production deps,layer 不會因 source code 變動而 invalidate |
| `builder` | 需要 dev deps + source code 跑 `next build`,但最終不進 runtime |
| `runner` | 只含 runtime 所需檔案,不含 build tools / dev deps / source code |

最終 image 大小 ~150MB(對比未優化的 ~600MB)。

### 3.2 `--mount=type=cache` 解釋

BuildKit feature,讓 `/root/.npm` 在多次 build 間共享。**只在 CI 環境(GitHub Actions buildx)有效**,本地 docker build 也支援。

不用 cache 的話,每次 build 都重新下載所有 npm 套件,CI 慢 2-5 分鐘。

### 3.3.1 Base image SHA bootstrap（初次 pin / 升級 SOP）

Dockerfile 預設值 `node:22-alpine@sha256:REPLACE_WITH_PINNED_DIGEST` 是占位符，**直接 `docker build` 會失敗**——這是刻意的 fail-fast：未經審視的 base image 不得進 build。

**第一次 pin 或升級流程**（任何人都可執行；CI dependabot 自動化此流程）：

```bash
# 1. 拉最新 tag
docker pull node:22-alpine

# 2. 取得本機 docker 看到的 manifest digest（不是 image ID，這是 registry-side digest）
DIGEST=$(docker buildx imagetools inspect node:22-alpine \
  --format '{{json .Manifest.Digest}}' | tr -d '"')

# fallback（無 buildx）：
# DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine \
#   | cut -d'@' -f2)

# 3. 確認 digest 格式
echo "$DIGEST" | grep -qE '^sha256:[a-f0-9]{64}$' || { echo "bad digest: $DIGEST"; exit 1; }

# 4. 替換 Dockerfile 內的 placeholder（macOS sed 需 '' 跟在 -i 後）
sed -i.bak "s|node:22-alpine@sha256:[a-zA-Z0-9_]*|node:22-alpine@${DIGEST}|" Dockerfile
rm Dockerfile.bak

# 5. 驗證 build 通過
docker build --pull=false -t playerledger-frontend:bootstrap-check .

# 6. 提交時 commit message 註明 base image 來源與時間
git add Dockerfile
git commit -m "chore(docker): pin node:22-alpine to ${DIGEST}"
```

**升級頻率**：dependabot 設定每週一次掃描 `docker` ecosystem，新 digest 自動開 PR；緊急 CVE 由人手動跑此流程。dependabot 設定範例見 [後端 infrastructure.md §23](../../PlayerLedgerBackend/docs/specs/infrastructure.md)。

> **為何使用 placeholder 而非具體 digest**：spec 是模板，提交時 digest 必然過期；具體值留給 CI / 開發者執行 bootstrap 流程後寫入。

### 3.3 為何選 alpine 而非 distroless

| 選項 | 大小 | 優點 | 缺點 |
|------|------|------|------|
| `node:22-alpine` | ~50MB base | 有 shell 可 debug、apk 可裝額外工具 | musl libc 與某些 native module 有相容性問題 |
| `gcr.io/distroless/nodejs22` | ~40MB base | 攻擊面最小、無 shell | 無法 exec 進去 debug、不能裝 curl 做 HEALTHCHECK |
| `node:22-slim` (Debian) | ~80MB base | glibc 相容性完美 | 比 alpine 大 |

選 **alpine**：

- 大小與 distroless 接近,但保留 shell 與 `apk` 方便日後 debug / 加診斷工具
- libc6-compat 套件解決多數 musl 相容性問題
- 業界普遍選擇,維護成本最低
- distroless 適合「絕對最小化」的場景,本專案不需要犧牲 debuggability 換那點 size

### 3.4 為何用 busybox wget 而非 curl / node 做 HEALTHCHECK

```
HEALTHCHECK CMD wget -q -O- "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
    | grep -q '"status":"ok"' || exit 1
```

替代方案：

| 方案 | 取捨 |
|------|------|
| `curl -f` | 需 `apk add curl`，增加 ~6MB image 與 libssl/libcrypto CVE 面；alpine busybox 已內建 wget，零成本 |
| `node -e "fetch(...)"` | cold start ~100ms，每 30s 一次容易被 GC pause 干擾；額外 RSS 佔用 |
| `wget -q --spider`（**已淘汰**） | 同 0 套件、但 busybox 實作對 **HTTP 4xx 仍 exit 0**——一旦路由 regression 讓 `/api/health` 變 404，HEALTHCHECK 假報健康，ECS / Docker 不會替換 task。**禁用** |
| `wget -q -O- + grep status:ok`（**採用**） | 多耗一次 body 解析（< 1ms），但能確認 body shape；對齊 spec 01 §9.1 的 health response `{"status":"ok",...}` |

`127.0.0.1` 而非 `localhost` 是為了避免 musl libc DNS 解析行為差異（v6/v4 切換造成偶發逾時）。`${PORT}` 透過 shell 形式 CMD 在 runtime 展開，PORT env 修改不會讓健康檢查靜默失效。

> **如果 `/api/health` 改 body shape**，HEALTHCHECK 的 grep pattern 必須同步調整；spec 01 §9.5 已有對應 contract 測試確保 shape 不漂移。

### 3.5 非 root 使用者的 UID 選擇

固定 UID/GID = 1001：
- 與大多數系統的 `nobody`(65534) / `daemon`(1) 區隔
- 跨環境一致,如果未來有 volume mount(目前無),host 不會出現「不知道是誰」的檔案擁有者
- ECS Fargate 雖然完全隔離,但養成習慣有益

### 3.6 訊號處理與優雅關閉

ECS rolling deploy（spec 01 §11.5）會送 `SIGTERM` 給舊 task，預設 30 秒後才強制 `SIGKILL`。期間 BFF 必須：

1. 停止接受新連線
2. 完成 in-flight 請求（含正在進行的 token refresh / proxy 轉發）
3. 關閉 Redis 連線、底層 keep-alive socket pool
4. 退出 process（exit code 0）

**為何需要 `tini` 當 PID 1：**

- Node.js 直接當 PID 1 時，**不會收割殭屍子行程**（Next.js standalone 的 image optimization、subprocess 都可能殘留）
- Node.js 對某些訊號（SIGINT 在某些 alpine 環境下）轉發行為不完全符合 POSIX
- `tini` 是 8KB 的最小 init，僅做兩件事：收割殭屍 + 把訊號轉送給子行程，這正是 PID 1 的職責

**Next.js 端的 graceful shutdown：**

Next.js 14+ 的 standalone server 已內建 SIGTERM handler（會等 in-flight 請求結束）。但 **本專案的 Redis client / fetch keep-alive socket pool 不會自動關閉**，需在 `instrumentation.ts` 或自訂 `server.js` wrapper 註冊：

```ts
// instrumentation-server.ts（Next.js 15 instrumentation hook 的 Node runtime 端）
import { redis } from '@/lib/session/redis'

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown.received')
    try { await redis.quit() } catch {}
    // Next.js standalone server 自身會等 in-flight 請求，這裡只負責清理 sidecar 資源
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT',  () => void shutdown('SIGINT'))
}
```

**ECS Task Definition 對應設定（任務於 deploy/task-definition.*.json 內表達）：**

| 欄位 | 值 | 理由 |
|------|-----|------|
| `stopTimeout` | **60（秒）** | Node.js graceful shutdown 需處理：(a) 拒絕新連線 (b) 等待 in-flight SSR/proxy 完成（最壞 ≤ API Gateway 29s 上限 + BFF own timeout）(c) `pino.flushSync()` 寫出 log buffer (d) `redis.quit()` 收尾。30s 在尾端 28s 的請求 + Redis quit 會被 SIGKILL 截斷、in-flight 客戶收到 connection reset；60s 留 ~25s buffer。**ALB target group `deregistration_delay.timeout_seconds` 必須對齊 60s**，否則 ALB 提早結束會讓尚未完成的請求消失。上限 120s |
| `deploymentConfiguration.minimumHealthyPercent` | 100 | 對應 spec 01 §11.5，新 task ready 才開始砍舊 task |
| `linuxParameters.initProcessEnabled` | **false** | 已用 `tini`，不要再啟用 ECS 自帶的 `init`（會雙層 init，訊號路徑變不明） |
| `readonlyRootFilesystem` | true | image 內無寫入需求；Next.js 仍會寫 `/tmp`（image optimization 暫存）與 `/app/.next/cache`（fetch cache / ISR），必須掛 tmpfs，否則啟動時 EROFS error |
| `mountPoints` + `volumes`（tmpfs） | `/tmp` → tmpfs 64MB、`/app/.next/cache` → tmpfs 256MB | 對應上一列。Fargate 用 `containerDefinitions[].mountPoints` 指向 `volumes[].name`，volume 設 `dockerVolumeConfiguration: {scope: "task", driver: "local", driverOpts: {type: "tmpfs"}}`。**若關閉 ISR / 不打 image-optimization API，仍需 `/tmp`**——pino transport / node 內部 tmp file 都會走它 |
| `linuxParameters.capabilities.drop` | `["ALL"]` | Next.js server 不需任何 Linux capability |
| `dockerSecurityOptions` | `["no-new-privileges:true"]` | 阻止子行程透過 setuid 提權 |

### 3.7 ECS 安全與資源限制檢查表

對應 §1 的「最小化 attack surface」原則，task definition 必須體現於：

- ✅ `readonlyRootFilesystem: true`
- ✅ `linuxParameters.capabilities.drop: ["ALL"]`
- ✅ `dockerSecurityOptions: ["no-new-privileges:true"]`
- ✅ `user: "1001:1001"`（與 Dockerfile UID 對齊；defense-in-depth）
- ✅ `ulimits` 設定 `nofile` soft=4096 / hard=8192（防 socket 耗盡 DoS）

這些設定不寫在 Dockerfile（屬於 runtime 信任邊界）但**屬於本規格的責任範圍**：CI 應加 lint 檢查 `deploy/task-definition.*.json` 含上述欄位。

---

## 4. .dockerignore

```
# .dockerignore

# Dependencies / build output（重新在 builder stage 產生）
node_modules
.next
.turbo

# VCS
.git
.gitignore
.gitattributes

# 環境變數與本機憑證（絕對禁止進 image layer history）
.env
.env.local
.env.*.local
.env.example
.npmrc                  # 可能含 npm auth token
*.pem
*.key
*.crt
*.p12
*.pfx
secrets/
**/credentials

# 基礎設施與部署設定（不該打包進 runtime image）
deploy/
terraform/
*.tf
*.tfstate*
infra/

# Test artifacts
coverage
.nyc_output
test-results
playwright-report
*.lcov

# Editor / OS
.vscode
.idea
.DS_Store
Thumbs.db
*.swp
*.swo

# Documentation（不需要進 image）
docs
*.md
!README.md

# CI / build metadata
.github
.circleci
Dockerfile*
docker-compose*.yml
.dockerignore

# Logs
*.log
npm-debug.log*
yarn-error.log*
```

**為何排除 `.next`：** builder stage 會在 image 內重新跑 `next build`,不複製 host 上可能過時或環境不符的產物。

**為何排除 `.env*` 與 `.npmrc`：** 環境變數由 ECS Task Definition 注入,**絕對禁止把任何含敏感資料的檔案包進 image**。`.npmrc` 在 CI 內常含 npm registry auth token，一旦進入 ECR layer history 就無法撤回——這是真實的 supply-chain 洩漏向量。

**為何排除 `Dockerfile*` 與 `.dockerignore`：** image 內不需要這些檔案；多餘的 layer 增加掃描面積。

**為何排除 `deploy/` / `terraform/`：** 部署設定、IAM role 名稱、AWS account ID 等屬於部署層機密，runtime image 不需要。

---

## 5. Build 指令

### 5.1 本地 build

```bash
docker build -t playerledger-frontend:dev .
docker run --rm -p 3000:3000 \
  -e REDIS_HOST=host.docker.internal \
  -e REDIS_PORT=6379 \
  -e API_BASE_URL=http://host.docker.internal:8080 \
  playerledger-frontend:dev
```

### 5.2 CI build（與 spec 01 §7.4 對齊）

```yaml
- uses: docker/build-push-action@v5
  id: build
  with:
    context: .
    push: true
    tags: |
      ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ steps.meta.outputs.tag }}
      ${{ steps.ecr.outputs.registry }}/playerledger-frontend:latest
    build-args: |
      APP_VERSION=${{ steps.meta.outputs.tag }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
    platforms: linux/amd64    # ECS Fargate 預設架構
    # supply chain：產出 SBOM 與 provenance attestation,push 進 ECR
    sbom: true
    provenance: mode=max

# 防呆：若 build-arg 漏傳，APP_VERSION 會是預設值 'unknown'，導致 log / metric 無法對應版本
- name: Assert APP_VERSION is not 'unknown'
  run: |
    APP_VER=$(docker run --rm --entrypoint sh ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ steps.meta.outputs.tag }} -c 'echo $APP_VERSION')
    if [ "$APP_VER" = "unknown" ] || [ -z "$APP_VER" ]; then
      echo "::error::APP_VERSION resolved to '$APP_VER' — CI must pass --build-arg APP_VERSION=<tag>"
      exit 1
    fi
    echo "APP_VERSION=$APP_VER OK"

# 防呆：image 大小預算（§1 最小化原則的可量測門檻）
- name: Assert image size budget
  run: |
    SIZE=$(docker image inspect ${{ steps.ecr.outputs.registry }}/playerledger-frontend:${{ steps.meta.outputs.tag }} --format '{{.Size}}')
    BUDGET=$((250 * 1024 * 1024))   # 250 MB
    if [ "$SIZE" -gt "$BUDGET" ]; then
      echo "::error::image size $SIZE bytes exceeds budget $BUDGET bytes"
      exit 1
    fi
    echo "image size=$((SIZE / 1024 / 1024))MB (budget 250MB)"
```

**為何加 SBOM / provenance：** SBOM 列出 image 內所有套件版本，CVE 應變時能立即查影響範圍；provenance attestation 證明 image 由哪個 commit / workflow run 產出，是 supply-chain 攻擊（依賴混淆、惡意 base image）的可審計痕跡。

**為何擋 `APP_VERSION=unknown` 進 production：** 沒有版本資訊的 image 上線後，log 與 metric 都會標 `version: "unknown"`，事故時無法精確對應 commit 進行回滾。

---

## 6. Image 驗證

### 6.1 Build 後 smoke test（CI 中執行）

驗證內容拆成「**離線檢查**」（不啟動 server）與「**runtime 檢查**」（啟動 container 模擬 ECS 行為）兩段。

**離線檢查：**

```bash
# UID 必須是 1001 nextjs（與 Dockerfile / ECS user 對齊）
docker run --rm --entrypoint sh playerledger-frontend:test -c '
  set -e
  test "$(id -u)" = "1001" || { echo "uid mismatch: $(id -u)"; exit 1; }
  test "$(id -un)" = "nextjs" || { echo "username mismatch: $(id -un)"; exit 1; }
  test -f /app/server.js
  test -x /sbin/tini
  command -v wget
  # 不應存在的東西
  ! test -d /app/node_modules/typescript
  ! test -f /app/.env
  ! test -f /app/.npmrc
  echo "smoke OK"
'

# 反模式：image layer history 不應包含任何疑似敏感字串
# 若有 build-arg 把 secret 拼進 RUN 指令，這裡會抓出來
docker history --no-trunc --format '{{.CreatedBy}}' playerledger-frontend:test \
  | grep -i -E '(password|secret|token|api[_-]?key)=' \
  && { echo "::error::secret-like string found in image layer history"; exit 1; } \
  || echo "history scan OK"
```

**Runtime 檢查（SIGTERM drain 行為驗證）：**

```bash
# /api/health 自 ADR 022 起為 liveness，不檢查 Redis，故 HEALTHCHECK 不需 live Redis 即可轉綠。
# 但 config.ts 在 module load fail-fast 驗證 REDIS_HOST 必填（缺值 server 起不來），故仍須提供
# REDIS_HOST env；下方 redis sidecar 改為可選——保留是為了一併煙霧測試 readiness /api/health/ready。
docker network create pl-smoke-net
docker run -d --name pl-smoke-redis --network pl-smoke-net \
  redis:7-alpine --save "" --appendonly no
docker run -d --name pl-smoke -p 13000:3000 --network pl-smoke-net \
  -e REDIS_HOST=pl-smoke-redis \
  -e API_BASE_URL=http://example.invalid \
  -e CLIENT_ID=cms-web \
  -e PUBLIC_ORIGIN=http://localhost:13000 \
  -e APP_VERSION=smoke \
  playerledger-frontend:test

cleanup() { docker rm -f pl-smoke pl-smoke-redis 2>/dev/null; docker network rm pl-smoke-net 2>/dev/null; }
trap cleanup EXIT

# 等到 HEALTHCHECK 翻 healthy（最多 60s）
for i in $(seq 1 12); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' pl-smoke 2>/dev/null || echo "starting")
  [ "$STATUS" = "healthy" ] && break
  sleep 5
done
[ "$STATUS" = "healthy" ] || { docker logs pl-smoke; exit 1; }

# 送 SIGTERM 並計時，container 應在 stopTimeout 內退出（不是被 SIGKILL 砍）
# stopTimeout 與 ECS task definition `stopTimeout: 60` 對齊（§3.6）
START=$(date +%s)
docker stop --time=60 pl-smoke
END=$(date +%s)
EXIT_CODE=$(docker inspect --format='{{.State.ExitCode}}' pl-smoke)
# pl-smoke / pl-smoke-redis / pl-smoke-net 由 trap cleanup 統一清理

# tini 收到 SIGTERM 轉 Node → Node graceful shutdown → exit 0
# 若沒 tini，PID 1 訊號被吃掉，會走到 SIGKILL，exit code = 137
[ "$EXIT_CODE" = "0" ] || { echo "::error::expected graceful exit 0, got $EXIT_CODE"; exit 1; }
[ $((END - START)) -lt 60 ] || { echo "::error::shutdown took $((END-START))s, likely SIGKILL'd"; exit 1; }
# 對 idle container（無 in-flight），shutdown 應該在 5s 內完成，超過代表 graceful 路徑卡住
[ $((END - START)) -lt 5 ]  || { echo "::warn::idle shutdown took $((END-START))s (>5s); investigate graceful path"; }
echo "graceful shutdown OK (${EXIT_CODE} in $((END-START))s)"
```

### 6.2 安全掃描（Trivy,在 CI 已配置 spec 01 §7.4 image-scan job）

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 playerledger-frontend:test
# secret scan：trivy 1.40+ 內建，能抓 image 內遺留的私鑰 / 高熵 token
trivy image --scanners secret --exit-code 1 playerledger-frontend:test
```

預期：0 個 HIGH / CRITICAL CVE、0 個 secret finding。若 base image (`node:22-alpine`) 出現新漏洞,build job 會擋住 deploy,需要：
1. 升級 base image 到較新 digest（dependabot PR）
2. 評估 CVE 是否實際影響本應用,必要時加 `.trivyignore` 並寫明過期日

### 6.3 必通過的驗收門檻（CI gate）

| 門檻 | 工具 | 期望 |
|------|------|------|
| Image 大小 | `docker image inspect` | ≤ 250 MB |
| 非 root user | smoke test UID 檢查 | UID = 1001 |
| tini 存在 | smoke test `test -x /sbin/tini` | 存在 |
| SIGTERM 優雅退出 | runtime smoke | exit 0 且 < 30s |
| `APP_VERSION` 不為 unknown | §5.2 assertion | `APP_VERSION != ''/unknown` |
| 無敏感字串於 layer history | smoke history scan | grep 無命中 |
| Trivy HIGH/CRITICAL CVE | trivy image | 0 |
| Trivy secret scan | trivy --scanners secret | 0 |

---

## 7. 反模式（不要這樣做）

- ❌ 用 `FROM node:22` 而非 `node:22-alpine` → image 從 150MB 變 1.2GB
- ❌ 只用 tag (`node:22-alpine`) 不釘 digest → tag 是可變指標，同名 rebuild 會讓你的「reproducible build」靜默漂移
- ❌ 用 `COPY . .` 在 deps stage → cache 不會 reuse,每次 build 都重裝 npm
- ❌ 不用 `output: 'standalone'` → 整個 `node_modules` 進 image,大 5 倍
- ❌ 用 root 跑 app → 出 RCE 漏洞時攻擊者拿到 root,危害放大
- ❌ 把 `.env` / `.npmrc` 包進 image → secret 永遠留在 ECR layer history,洩漏不可逆
- ❌ build 時把 secret 用 `--build-arg` 傳入 → secret 會進 image layer metadata,docker inspect 可見;改用 BuildKit secret mount 或 runtime env
- ❌ 沒有 HEALTHCHECK → ECS / docker daemon 無法判斷 container 是否健康,只看 process 是否存活
- ❌ HEALTHCHECK 寫死 port（`localhost:3000`）→ 改 PORT env 後健康檢查靜默壞掉、ECS 一直判 healthy
- ❌ Node 直接當 PID 1（缺 tini / dumb-init）→ 不收割殭屍、SIGTERM 行為不可預期，deploy 滾動更新時 in-flight 請求被砍
- ❌ 用 `latest` tag 跑 production → 無法精確回滾,應用永遠是「不知道哪一版」
- ❌ `APP_VERSION` 沒在 CI 強制檢查 → build-arg 漏傳時 production 進入「unknown 版本」狀態，事故追溯失效

---

## 8. 後續優化方向（v2 再考慮）

- **多架構 image**：加 `linux/arm64`(Graviton 便宜 20%)。需先驗證 ARM 上的 ioredis / openapi-fetch 等 native dep 相容性
- **Image signing**：cosign 簽章 + admission policy 拒絕未簽章 image（SBOM 與 provenance attestation 已於 §5.2 v1 完成）
- **Distroless 升級**：若未來不需要 in-container debug,可試 distroless 進一步減 attack surface
- **多 task / Graviton 後評估 ENTRYPOINT 改 dumb-init**：tini 與 dumb-init 行為近似,tini 在 ARM 上某些 musl 邊界曾報 issue,屆時再評估

---

## 9. 關聯文件

- [BFF 架構規格](./01-bff-architecture.md) §9（健康檢查端點)、§11（CD pipeline、ECS Service 設定）
- [Observability 規格](./03-observability.md) §4.3（ADOT collector sidecar 是同一 task definition 內的第二個 container，本規格僅描述 BFF 主 container）
- [ADR 001 - 部署架構](../adr/001-deployment-architecture.md)（為何 ECS Fargate）

> **與 ADOT collector 的關係**：本規格只規範 BFF 主 container 的 image。Observability spec §4.3 的 ADOT collector 以 sidecar 形式加入同一個 ECS task definition，由 `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` 進行 loopback 通訊。Task definition 中應有兩個 containerDefinitions（BFF + adot-collector），兩者都遵循 §3.6 的 stopTimeout / readonly fs 等設定。
