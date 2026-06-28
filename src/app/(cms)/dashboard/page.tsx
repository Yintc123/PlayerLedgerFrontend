/**
 * 受保護頁面示例
 * Server Component 進行 SSR（此處為示例，實際應用會複雜得多）
 */
export default async function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>
      <p>This is a protected page. Session is validated server-side via layout.</p>
      <p>Client components in this tree can use useSession() hook to access session data.</p>
    </div>
  );
}
