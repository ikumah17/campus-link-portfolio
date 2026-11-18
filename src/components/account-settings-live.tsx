"use client";
import { useRouter } from "next/navigation";
import { AccountSettingsView } from "@/components/account-settings";
import { deleteAccount, pauseAccount, resumeAccount } from "@/server/account-actions";
import type { AccountState } from "@/server/account-rules";

const actions = { pause: pauseAccount, resume: resumeAccount, remove: deleteAccount };
export function AccountSettingsLive({ accountStatus }: { accountStatus: AccountState }) {
  const router = useRouter();
  return <AccountSettingsView initialState={accountStatus} actions={actions} onStale={() => router.refresh()} />;
}
