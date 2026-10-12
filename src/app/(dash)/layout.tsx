import { Sidebar } from "@/components/client";
import { navBadges } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export default async function DashLayout({ children }: { children: React.ReactNode }) {
  let badges: Record<string, number> = {};
  try { badges = await navBadges(); } catch { /* DB down: health page will say so */ }
  return (
    <div className="min-h-screen">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_top,#8b5cf614,transparent_70%)]" />
      <Sidebar badges={badges} />
      <main className="relative px-4 pb-16 pt-16 sm:px-6 lg:ml-60 lg:px-10 lg:pt-10">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
