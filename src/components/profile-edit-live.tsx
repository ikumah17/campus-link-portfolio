"use client";
import { ProfileEditView, type ProfileEditInput } from "@/components/profile-edit";
import { saveMyProfile } from "@/server/profile-edit-actions";

export function ProfileEditLive({ initial }: { initial: ProfileEditInput }) {
  return <ProfileEditView initial={initial} save={saveMyProfile} />;
}
