import { AdminProvider } from "@/lib/admin-demo";
import { backendMode } from "@/lib/backend";
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return backendMode() === "demo" ? <AdminProvider>{children}</AdminProvider> : children;
}
