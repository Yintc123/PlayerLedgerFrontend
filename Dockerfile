# syntax=docker/dockerfile:1.7

# =============================================================================
# Base image：PoC 階段先用 tag，production 前要改回 @sha256 digest 釘版（spec 04 §3.3.1）
# 升級 digest SOP：
#   docker pull node:22-alpine --platform linux/amd64
#   docker inspect node:22-alpine --format '{{index .RepoDigests 0}}'
# =============================================================================
ARG NODE_IMAGE=node:22-alpine

# =============================================================================
# Stage 1: Dependencies
# 只裝 production deps，獨立 layer 讓 cache 可重用
# =============================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# libc6-compat 是某些 npm 套件的 native binding 依賴
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

# build 時注入版本資訊，讓 /api/health 可回傳 version
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1

# config.ts 在 module load 時 fail-fast 驗證必填 env（REDIS_HOST/API_BASE_URL/...）。
# next build 收集 page data 會 import 到 config，故 build 階段需佔位值。
# 這些只在 build 期有效，runtime 由 ECS task definition 的 env/secrets 覆蓋。
ENV REDIS_HOST=localhost \
    API_BASE_URL=http://localhost:8080 \
    PUBLIC_ORIGIN=http://localhost:3000 \
    CLIENT_ID=cms-web

RUN npm run build

# =============================================================================
# Stage 3: Runner
# 最小化 runtime，只含 standalone server + static assets + tini
# =============================================================================
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NODE_OPTIONS="--max-old-space-size=400"

# 建立非 root 使用者（UID/GID 固定數字）
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# tini：PID 1 收割殭屍 + 轉送 SIGTERM 給 Node.js
# wget：busybox 內建，用於 HEALTHCHECK（不裝 curl，避免引入額外 CVE）
RUN apk add --no-cache tini

# 複製 standalone server（已含必要 node_modules）
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# standalone 不會自動複製這兩個目錄
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

# HEALTHCHECK：下載 body 並 grep "status":"ok"，對應 spec 01 §9.1 的 response shape
# 不用 wget --spider：busybox wget --spider 在 HTTP 4xx 仍 exit 0（路由失誤時假綠燈）
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q -O- "http://127.0.0.1:${PORT}/api/health" 2>/dev/null \
        | grep -q '"status":"ok"' || exit 1

# tini 處理 PID 1 行為：收割殭屍 + 轉送訊號（SIGTERM/SIGINT）給 Node.js
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
