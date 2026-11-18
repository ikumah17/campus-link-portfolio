"use client";

import { secondaryButton } from "@/components/auth-demo-form";
import { textLink } from "@/components/ui-tokens";
import { declineConfirmedAction, signOutAction, signOutEverywhereAction } from "@/server/auth-actions";

export function LogoutButton() {
  // React form actions return void; discard only the demo-mode unavailable state.
  async function logout() {
    await signOutAction();
  }
  return <form action={logout} className="mt-8"><button type="submit" className={secondaryButton}>ログアウト</button></form>;
}

// The quieter control under LogoutButton: ends the sessions on every device.
export function LogoutEverywhereButton() {
  async function logoutEverywhere() {
    await signOutEverywhereAction();
  }
  return <form action={logoutEverywhere} className="mt-2"><button type="submit" className={`${textLink} text-muted`}>すべての端末からログアウト</button></form>;
}

// /auth/confirmed: leave an account that a confirmation link signed in on this device.
export function NotMyAccountButton() {
  async function decline() {
    await declineConfirmedAction();
  }
  return <form action={decline}><button type="submit" className={`${secondaryButton} w-full`}>自分のアカウントではありません</button></form>;
}
