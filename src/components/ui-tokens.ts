// Shared class strings so every screen reads as one system (docs/02_UI_DESIGN.md).
// A plain module, not "use client", so server components can import the same values.
export const primaryButton = "inline-flex min-h-12 items-center justify-center rounded-full bg-ink px-6 py-3 text-[15px] font-medium text-white";
export const secondaryButton = "inline-flex min-h-12 items-center justify-center rounded-full border border-line bg-white px-6 py-3 text-[15px]";
export const textLink = "inline-flex min-h-11 min-w-11 items-center py-2 text-[14px] underline underline-offset-4";
export const inputClass = "mt-2 min-h-12 w-full min-w-0 rounded-[16px] border border-line bg-white px-4 py-3 text-[16px]";

export const pageTitle = "text-[28px] font-medium leading-tight";
// Screens with the bottom navigation, and standalone screens (sign-in, admin, documents).
export const tabPage = "mx-auto w-full max-w-2xl px-4 pb-40 pt-6 sm:px-8 sm:pt-10";
export const standalonePage = "mx-auto min-h-screen w-full max-w-[560px] px-4 pb-16 pt-10 sm:px-8 sm:pt-20";
// Demo or safety notice directly under a page title.
export const noticeText = "mt-3 text-[13px] leading-6 text-muted";
export const noteBox = "rounded-[20px] bg-surface p-4 text-[13px] leading-6 text-muted";
export const emptyState = "rounded-[24px] bg-surface p-6 text-sm leading-6 text-muted";
export const loadingText = "text-sm text-muted";
