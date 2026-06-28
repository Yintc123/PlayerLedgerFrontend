import Redis from 'ioredis'
import { config } from '@/lib/config'

const globalForRedis = globalThis as typeof globalThis & { redis?: Redis; healthRedis?: Redis }

export const redis =
  globalForRedis.redis ??
  new Redis({
    host:                 config.redis.host,
    port:                 config.redis.port,
    password:             config.redis.password,
    db:                   config.redis.db,
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
  })

if (!config.isProd) {
  globalForRedis.redis = redis
}

// 專用於健康檢查的 Redis 連接（獨立 timeout 配置）
export const healthRedis =
  globalForRedis.healthRedis ??
  new Redis({
    host:                 config.redis.host,
    port:                 config.redis.port,
    password:             config.redis.password,
    db:                   config.redis.db,
    commandTimeout:       2000,   // 指令層級 timeout，整個 ping round-trip 2s 後 reject
    connectTimeout:       2000,   // connect 階段 timeout（重啟後第一次健康檢查觸發）
    maxRetriesPerRequest: 0,      // 健康檢查不重試，2s 內必有答案
    enableOfflineQueue:   false,  // Redis 斷線時直接 reject，不暫存指令
  })

if (!config.isProd) {
  globalForRedis.healthRedis = healthRedis
}
