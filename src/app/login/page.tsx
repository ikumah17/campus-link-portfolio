import { AuthDemoForm } from "@/components/auth-demo-form";
import { AuthForm } from "@/components/auth-form";
import { backendMode } from "@/lib/backend";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; error?: string | string[] }> }) {
  if (backendMode() === "demo") return <AuthDemoForm kind="login" />;
  const params = await searchParams;
  return <AuthForm kind="login" next={typeof params.next === "string" ? params.next : undefined} confirmError={params.error === "confirm"}
    signoutError={params.error === "signout"} />;
}
