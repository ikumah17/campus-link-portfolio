import { AuthDemoForm } from "@/components/auth-demo-form";
import { AuthForm } from "@/components/auth-form";
import { backendMode } from "@/lib/backend";

export default function SignupPage() {
  return backendMode() === "demo" ? <AuthDemoForm kind="signup" /> : <AuthForm kind="signup" />;
}
