import type { Metadata } from "next";
import { AccountDeleted } from "@/components/account-settings";
import { backendMode } from "@/lib/backend";
// Static and public in the proxy: the session has already ended when the deletion action redirects here.
export const metadata: Metadata = { title: "退会の手続きが完了しました | Campus Link" };
export default function Page() { return <AccountDeleted demo={backendMode() === "demo"} />; }
