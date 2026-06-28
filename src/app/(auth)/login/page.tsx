'use client';

import { FormEvent, useState, useEffect } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Wallet } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function safeRedirectTarget(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

// Read search params via useEffect (client mount) to avoid Next.js prerender error.
// useSearchParams() requires <Suspense> which defers form from SSR HTML — hurts e2e tests.
function LoginForm() {
  const [registered, setRegistered] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setRegistered(params.get('registered') === 'true');
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.message || data.error || '登入失敗');
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const target = safeRedirectTarget(params.get('redirect'));
      window.location.replace(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : '網路錯誤');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="relative w-full max-w-sm shadow-xl">
      <CardHeader className="space-y-1 text-center">
        <div className="bg-foreground text-background mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
          <Wallet className="size-6" aria-hidden="true" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">PlayerLedger</CardTitle>
        <CardDescription>登入後台以查詢玩家儲值紀錄</CardDescription>
      </CardHeader>

      <CardContent>
        {registered && (
          <Alert className="mb-4">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            <AlertDescription>註冊成功，請以新帳號登入</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">帳號</Label>
            <Input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">密碼</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                登入中…
              </>
            ) : (
              '登入'
            )}
          </Button>

          <div className="relative my-2 flex items-center">
            <div className="flex-grow border-t border-muted" />
            <span className="mx-3 text-xs text-muted-foreground">或</span>
            <div className="flex-grow border-t border-muted" />
          </div>

          <div className="text-center text-sm text-muted-foreground">
            還沒有帳號？
            <Link
              href="/register"
              className="text-foreground font-medium underline-offset-4 hover:underline"
            >
              建立 CMS 帳號
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 px-4 py-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-fuchsia-200/30 blur-3xl"
      />
      <LoginForm />
      <p className="text-muted-foreground absolute bottom-6 text-xs">© PlayerLedger · 內部後台</p>
    </main>
  );
}
