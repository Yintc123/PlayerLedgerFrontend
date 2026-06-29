import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * 相關連結區（spec 11 §4.5 / §6）。`<nav aria-label="related links">`。
 * 玩家詳情、玩家儲值列表恆顯示；外部訂單系統為 v2，暫不實作。
 */
export function RelatedLinks({ playerId }: { playerId: string }) {
  const links = [
    { href: `/players/${playerId}`, label: '玩家詳情' },
    { href: `/players/${playerId}/topups`, label: '玩家儲值列表' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>相關連結</CardTitle>
      </CardHeader>
      <CardContent>
        <nav aria-label="related links">
          <ul className="space-y-1">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="focus-visible:ring-ring flex items-center justify-between rounded-md px-2 py-2 text-sm text-blue-600 outline-none hover:bg-slate-50 hover:underline focus-visible:ring-2"
                >
                  <span>{link.label}</span>
                  <ChevronRight className="size-4 text-slate-400" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </CardContent>
    </Card>
  );
}
