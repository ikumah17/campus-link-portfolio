// The profile edit screen (docs/43 §4.5): the reader, the action, the page and the form.
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ mode: "supabase", create: vi.fn(), rpc: vi.fn(), revalidate: vi.fn(), gate: vi.fn(), save: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend", () => ({ backendMode: () => m.mode }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: m.create }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (s: string) => { throw Error(`REDIRECT:${s}`); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/profile-gate", () => ({ profileGate: m.gate }));
vi.mock("@/components/main-nav", () => ({ MainNav: () => null }));
import { loadMyProfile } from "@/server/profile-edit-data";
import { saveMyProfile } from "@/server/profile-edit-actions";
import { ProfileEditView, ProfileEdit } from "@/components/profile-edit";
import Page, { generateMetadata } from "@/app/mypage/profile/page";

const row = { display_name: "葵", gender: "female", bio: "紹介", purposes: ["talk"], hobbies: ["読書"] };
const table = (data: unknown, error: object | null = null, status = 200) => ({ from: vi.fn(() => ({ select: vi.fn(() => ({ limit: async () => ({ data, error, status }) })) })) });
const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
beforeEach(() => { vi.clearAllMocks(); m.mode = "supabase"; });
afterEach(() => expect(fetchSpy).not.toHaveBeenCalled());

describe("own profile reader", () => {
  it("reads only the own row's editable and resent fields", async () => {
    const c = table([{ ...row, birth_date: "private" }]);
    expect(await loadMyProfile(c as never)).toEqual({ status: "ok", profile: { displayName: "葵", gender: "female", bio: "紹介", purposes: ["talk"], hobbies: ["読書"] } });
    expect(c.from).toHaveBeenCalledWith("profiles");
    expect(await loadMyProfile(table([{ ...row, bio: null, hobbies: null }]) as never)).toMatchObject({ status: "ok", profile: { bio: "", hobbies: [] } });
  });
  it("fails closed on a malformed or missing row and maps an expired session", async () => {
    for (const bad of [[], [row, row], [null], [{ ...row, purposes: ["romance"] }], [{ ...row, purposes: null }], [{ ...row, gender: "x" }], [{ ...row, display_name: "" }], [{ ...row, bio: "a".repeat(501) }], [{ ...row, hobbies: [1] }]])
      expect(await loadMyProfile(table(bad) as never)).toEqual({ status: "unavailable" });
    expect(await loadMyProfile(table(null, { code: "PGRST301" }) as never)).toEqual({ status: "unauthenticated" });
    expect(await loadMyProfile(table(null, { code: "XX000", message: "private" }) as never)).toEqual({ status: "unavailable" });
  });
});

describe("save action", () => {
  beforeEach(() => { m.create.mockResolvedValue({ ...table([row]), rpc: m.rpc }); m.rpc.mockResolvedValue({ data: { ok: true, code: "ok", ref: null }, error: null }); });
  it("rejects invalid input before creating a client", async () => {
    for (const bad of [null, {}, { bio: 1, purposes: [] }, { bio: "", purposes: ["romance"] }, { bio: "", purposes: ["talk", "talk"] }, { bio: "a".repeat(501), purposes: [] }, { bio: "", purposes: "talk" }])
      expect(await saveMyProfile(bad)).toEqual({ status: "invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });
  it("sends the edited bio and purposes with the current name, gender and hobbies", async () => {
    expect(await saveMyProfile({ bio: "新しい紹介", purposes: ["friends", "study"] })).toEqual({ status: "ok" });
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("update_profile", { p_display_name: "葵", p_gender: "female", p_bio: "新しい紹介", p_purposes: ["friends", "study"], p_hobbies: ["読書"] });
    expect(m.revalidate).toHaveBeenCalledWith("/mypage/profile");
  });
  it.each([[{ code: "P0001", message: "validation" }, "invalid"], [{ code: "P0001", message: "forbidden" }, "unavailable"], [{ code: "PGRST301", message: "x" }, "unauthenticated"], [{ code: "PGRST202", message: "missing" }, "unavailable"]] as const)("maps %o", async (error, status) => {
    m.rpc.mockResolvedValue({ data: null, error });
    expect(await saveMyProfile({ bio: "", purposes: [] })).toEqual({ status });
  });
  it("stops when the own row cannot be read, and is inert in demo", async () => {
    m.create.mockResolvedValue({ ...table([]), rpc: m.rpc });
    expect(await saveMyProfile({ bio: "", purposes: [] })).toEqual({ status: "unavailable" });
    expect(m.rpc).not.toHaveBeenCalled();
    m.create.mockClear(); m.mode = "demo";
    expect(await saveMyProfile({ bio: "", purposes: [] })).toEqual({ status: "unavailable" });
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("page", () => {
  it("shows the demo without a client and titles both modes", async () => {
    m.mode = "demo"; render(await Page());
    expect(screen.getByRole("heading", { level: 1, name: "プロフィールを編集" })).toBeInTheDocument();
    expect(screen.getByText("デモ：変更は架空のもので、どこにも保存されません。")).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
    expect((await generateMetadata()).title).toBe("プロフィールを編集（デモ）| Campus Link");
  });
  it.each([["incomplete", "REDIRECT:/onboarding"], ["unauthenticated", "REDIRECT:/login?next=%2Fmypage%2Fprofile"]])("redirects gate %s", async (gate, target) => {
    m.create.mockResolvedValue(table([row])); m.gate.mockResolvedValue(gate);
    await expect(Page()).rejects.toThrow(target);
  });
  it("fills the form from the own row, or shows the fixed failure", async () => {
    m.create.mockResolvedValue(table([row])); m.gate.mockResolvedValue("completed");
    render(await Page());
    expect(screen.getByLabelText("自己紹介（任意）")).toHaveValue("紹介");
    expect(screen.getByLabelText("話し相手がほしい")).toBeChecked();
    expect(screen.getByLabelText("友達がほしい")).not.toBeChecked();
    m.create.mockResolvedValue(table([]));
    render(await Page());
    expect(screen.getByRole("alert")).toHaveTextContent("現在表示できません。時間をおいて再度お試しください。");
  });
});

describe("form", () => {
  it("saves once at a time in the fixed order and reports the result", async () => {
    let resolve!: (v: { status: "ok" }) => void; m.save.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = render(<ProfileEditView initial={{ bio: "", purposes: [] }} save={m.save} />);
    expect(container.textContent).not.toMatch(/モード|恋愛|申請/);
    fireEvent.click(screen.getByLabelText("話し相手がほしい")); fireEvent.click(screen.getByLabelText("友達がほしい"));
    fireEvent.change(screen.getByLabelText("自己紹介（任意）"), { target: { value: "よろしく" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("button", { name: "保存する" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(m.save).toHaveBeenCalledExactlyOnceWith({ bio: "よろしく", purposes: ["friends", "talk"] });
    resolve({ status: "ok" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存しました。"));
    expect(screen.getByRole("status")).toHaveFocus();
    expect(screen.getByRole("link", { name: "マイページへ戻る" })).toHaveAttribute("href", "/mypage");
  });
  it("checks the bio length before saving", () => {
    render(<ProfileEditView initial={{ bio: "", purposes: [] }} save={m.save} />);
    fireEvent.change(screen.getByLabelText("自己紹介（任意）"), { target: { value: "😀".repeat(501) } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByText("自己紹介は500文字以内で入力してください。")).toBeInTheDocument();
    expect(screen.getByLabelText("自己紹介（任意）")).toHaveAttribute("aria-invalid", "true");
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each([["invalid", "入力内容を確認してください。"], ["unauthenticated", "ログインし直してください。"], ["unavailable", "現在保存できません。時間をおいて再度お試しください。"], ["thrown", "現在保存できません。時間をおいて再度お試しください。"]])("shows the fixed answer %s", async (status, text) => {
    if (status === "thrown") m.save.mockRejectedValue(Error("private")); else m.save.mockResolvedValue({ status });
    render(<ProfileEditView initial={{ bio: "", purposes: [] }} save={m.save} />);
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(text));
  });
  it("the demo saves nowhere", async () => {
    render(<ProfileEdit />);
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存しました（デモ・どこにも保存されません）。"));
  });
});
