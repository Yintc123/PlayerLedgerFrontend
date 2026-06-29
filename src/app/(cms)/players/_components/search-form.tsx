'use client';

import { FormEvent, KeyboardEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PlayerSearchQuery } from '../_lib/types';
import { serializeSearchQuery } from '../_lib/query-params';

const FIELDS = [
  { name: 'playerId', label: '玩家 ID', type: 'text', placeholder: '01HABCD...' },
  { name: 'externalId', label: '外部 ID', type: 'text', placeholder: '遊戲端 ID' },
  { name: 'displayName', label: '暱稱', type: 'text', placeholder: '玩家暱稱前綴' },
  { name: 'email', label: 'Email', type: 'email', placeholder: 'name@example.com' },
  { name: 'phone', label: '手機', type: 'tel', placeholder: '+886912345678' },
] as const;

type FieldName = (typeof FIELDS)[number]['name'];

/**
 * 搜尋表單（spec 08 §4）。受控表單；提交不打 API，改 router.push 讓 page.tsx 重新 SSR。
 */
export function SearchForm({ initialQuery }: { initialQuery: PlayerSearchQuery }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<FieldName, string>>({
    playerId: initialQuery.playerId ?? '',
    externalId: initialQuery.externalId ?? '',
    displayName: initialQuery.displayName ?? '',
    email: initialQuery.email ?? '',
    phone: initialQuery.phone ?? '',
  });

  const isEmpty = FIELDS.every((f) => values[f.name].trim().length === 0);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isEmpty) return;
    const query: PlayerSearchQuery = {};
    for (const f of FIELDS) {
      const v = values[f.name].trim();
      if (v) query[f.name] = values[f.name];
    }
    router.push(`/players${serializeSearchQuery(query)}`);
  };

  const handleClear = () => {
    setValues({ playerId: '', externalId: '', displayName: '', email: '', phone: '' });
    router.push('/players');
  };

  const handleKeyDown = (name: FieldName) => (e: KeyboardEvent<HTMLInputElement>) => {
    // Esc：清空當前欄位（不清整表），且僅在有值時
    if (e.key === 'Escape' && values[name].length > 0) {
      e.preventDefault();
      setValues((prev) => ({ ...prev, [name]: '' }));
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border bg-white p-4"
      aria-label="玩家搜尋表單"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.name} className="space-y-1.5">
            <Label htmlFor={f.name}>{f.label}</Label>
            <Input
              id={f.name}
              name={f.name}
              type={f.type}
              placeholder={f.placeholder}
              value={values[f.name]}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
              onKeyDown={handleKeyDown(f.name)}
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" disabled={isEmpty}>
          <Search className="size-4" aria-hidden="true" />
          搜尋
        </Button>
        <Button type="button" variant="ghost" onClick={handleClear}>
          <X className="size-4" aria-hidden="true" />
          清除
        </Button>
      </div>
    </form>
  );
}
