'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { Loader2, Wallet } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function normalizeErrorCode(s: string): string {
  return s.replace(/\s+/g, '_').toLowerCase();
}

function mapErrorMessage(data: { error?: string; message?: string }): string {
  const code = normalizeErrorCode(data.error ?? '');
  switch (code) {
    case 'username_taken':
      return '此帳號已被使用，請換一個';
    case 'weak_password':
      return '密碼強度不足；需至少 8 字元且同時含字母與數字';
    case 'invalid_client':
      return '服務設定錯誤，請聯絡管理員';
    case 'too_many_requests':
      return '操作過於頻繁，請稍後再試';
    case 'invalid_input':
      return data.message ?? '輸入格式不正確';
    default:
      return data.message ?? '建立帳號失敗';
  }
}

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (confirmPassword !== password) {
      setError('密碼與確認密碼不一致');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (response.ok) {
        window.location.replace('/login?registered=true');
        return;
      }

      const data = await response.json().catch(() => ({}));
      if (response.status >= 500) {
        setError('服務暫時無法使用，請稍後再試');
      } else {
        setError(mapErrorMessage(data));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message || '網路錯誤' : '網路錯誤');
    } finally {
      setLoading(false);
    }
  };

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

      <Card className="relative w-full max-w-sm shadow-xl">
        <CardHeader className="space-y-1 text-center">
          <div className="bg-foreground text-background mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
            <Wallet className="size-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">PlayerLedger</CardTitle>
          <CardDescription>建立 CMS 帳號</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">帳號</Label>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                minLength={3}
                maxLength={64}
                required
                disabled={loading}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密碼</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={256}
                required
                disabled={loading}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-muted-foreground mt-1.5 text-xs">至少 8 字元，需含字母與數字</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">確認密碼</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                disabled={loading}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
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
                  建立中…
                </>
              ) : (
                '建立帳號'
              )}
            </Button>

            <div className="mt-4 text-center text-sm text-muted-foreground">
              已有帳號？
              <Link
                href="/login"
                className="text-foreground font-medium underline-offset-4 hover:underline"
              >
                返回登入
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-muted-foreground absolute bottom-6 text-xs">© PlayerLedger · 內部後台</p>
    </main>
  );
}
