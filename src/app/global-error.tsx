'use client'

import { useEffect } from 'react'
import { logger } from '@/lib/logger/logger'

type GlobalErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * 全局错误边界 (§6.1)
 * 捕获所有未处理的客户端错误，发送到 /api/client-errors
 */
export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // 生成稳定的错误指纹以去重
    const fingerprint = generateFingerprint(error)

    // 发送到后端
    reportError({
      message: error.message,
      stack: error.stack || '',
      fingerprint,
      digest: error.digest,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      route: typeof window !== 'undefined' ? window.location.pathname : '',
    })

    // 本地记录
    logger.error(
      {
        type: 'client.error.global',
        message: error.message,
        fingerprint,
        digest: error.digest,
      },
      'Unhandled client error',
    )
  }, [error])

  return (
    <html>
      <body>
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
          <h1>抱歉，发生了错误</h1>
          <p>应用程序遇到了意外的错误。我们已经记录了这个问题。</p>
          <button
            onClick={() => reset()}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              cursor: 'pointer',
              backgroundColor: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
            }}
          >
            尝试恢复
          </button>
        </div>
      </body>
    </html>
  )
}

/**
 * 生成稳定的错误指纹，用于在 CloudWatch 中去重
 */
function generateFingerprint(error: Error): string {
  // 基于错误信息和堆栈的前几行生成 hash
  const content = `${error.message}:${(error.stack || '').split('\n').slice(0, 3).join('|')}`
  // 简单的 hash - 生产环境应该使用更好的方案
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `error-${Math.abs(hash)}`
}

/**
 * 将错误报告发送到 /api/client-errors
 */
async function reportError(data: {
  message: string
  stack: string
  fingerprint: string
  digest?: string
  userAgent: string
  route: string
}) {
  try {
    // 使用 sendBeacon 确保请求被发送（即使页面卸载）
    if (navigator?.sendBeacon) {
      navigator.sendBeacon(
        '/api/client-errors',
        JSON.stringify(data),
      )
    } else {
      // Fallback to fetch
      await fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        // 页面卸载时使用 keepalive
        keepalive: true,
      })
    }
  } catch (err) {
    // 错误报告本身失败时静默处理
    console.error('[ErrorReporting]', err)
  }
}
