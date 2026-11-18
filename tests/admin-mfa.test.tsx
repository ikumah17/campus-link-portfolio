import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminMfa } from "@/components/admin-mfa";

const mocks = vi.hoisted(() => ({ enroll: vi.fn(), verify: vi.fn(), assign: vi.fn() }));
vi.mock("@/server/mfa-actions", () => ({ startTotpEnrollment: mocks.enroll, verifyTotp: mocks.verify }));
const qrCode = "data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E";
const secret = "FICTIONALTESTKEY";
let fetchSpy: ReturnType<typeof vi.spyOn>;
let storageSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  vi.resetAllMocks();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  storageSpies = ["setItem", "removeItem"].map((method) => vi.spyOn(Storage.prototype, method as "setItem"));
  mocks.enroll.mockResolvedValue({ status: "enroll", qrCode, secret });
  mocks.verify.mockResolvedValue({ status: "invalid_code" });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  for (const spy of storageSpies) expect(spy).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const submit = () => {
  const input = screen.getByLabelText("6桁のコード");
  fireEvent.change(input, { target: { value: "012345" } });
  fireEvent.submit(input.closest("form")!);
};

describe("admin TOTP form", () => {
  it("offers enrollment, shows only the returned QR and manual key, and keeps them out of URLs", async () => {
    const { container } = render(<AdminMfa mode="enroll" next="/admin/verifications" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("二段階認証");
    expect(screen.queryByLabelText("6桁のコード")).not.toBeInTheDocument();
    await userEvent.setup({ delay: null }).click(screen.getByRole("button", { name: "認証アプリを設定する" }));
    expect(screen.getByRole("img")).toHaveAttribute("src", qrCode);
    expect(screen.getByRole("img")).toHaveAccessibleName("認証アプリに読み取らせるQRコード");
    expect(screen.getByRole("img")).toHaveAttribute("width", "200");
    expect(screen.getByRole("img")).toHaveAttribute("height", "200");
    expect(screen.getByLabelText("手入力用のキー")).toHaveTextContent(secret);
    expect(screen.getByText("認証アプリでQRコードを読み取り、6桁のコードを入力してください。")).toBeInTheDocument();
    expect(container.querySelector("a, input[type=hidden]")).toBeNull();
    expect(window.location.href).not.toContain(secret);
    expect(screen.queryByText(/デモ/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "認証アプリを設定する" })).not.toBeInTheDocument();
  });
  it("uses accessible code controls and supports keyboard submission", async () => {
    render(<AdminMfa mode="challenge" next="/admin" />);
    const code = screen.getByLabelText("6桁のコード");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("maxlength", "6");
    expect(code).toHaveClass("min-h-12");
    expect(screen.getByRole("button", { name: "確認" })).toHaveClass("min-h-12");
    const user = userEvent.setup({ delay: null });
    await user.tab(); expect(code).toHaveFocus();
    await user.type(code, "012345{Enter}");
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith("012345"));
    expect(code).toHaveValue("");
    expect(mocks.enroll).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("switches to challenge if a factor is already verified", async () => {
    mocks.enroll.mockResolvedValue({ status: "already_enrolled" });
    render(<AdminMfa mode="enroll" next="/admin" />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button"));
    expect(screen.getByLabelText("6桁のコード")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("手入力用のキー")).not.toBeInTheDocument();
  });
  it.each([
    ["invalid_code", "コードが正しくありません。もう一度入力してください。"],
    ["rate_limited", "試行回数が上限に達しました。しばらくしてからお試しください。"],
    ["unauthenticated", "ログインの有効期限が切れました。"],
    ["unavailable", "現在確認できません。時間をおいて再度お試しください。"],
  ])("announces %s", async (status, message) => {
    mocks.verify.mockResolvedValue({ status });
    render(<AdminMfa mode="challenge" next="/admin" />);
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    if (status === "unauthenticated") expect(screen.getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/admin/mfa");
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "unauthenticated"])("announces enrollment %s", async (status) => {
    mocks.enroll.mockResolvedValue({ status });
    render(<AdminMfa mode="enroll" next="/admin" />);
    await userEvent.setup({ delay: null }).click(screen.getByRole("button"));
    expect(screen.getByRole("alert")).toHaveTextContent(status === "unavailable" ? "現在確認できません。時間をおいて再度お試しください。" : "ログインの有効期限が切れました。");
  });
  it("allows only one enrollment while pending", async () => {
    let finish!: (result: { status: string }) => void;
    mocks.enroll.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<AdminMfa mode="enroll" next="/admin" />);
    const button = screen.getByRole("button");
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(mocks.enroll).toHaveBeenCalledOnce();
    await act(async () => finish({ status: "already_enrolled" }));
    expect(screen.getByLabelText("6桁のコード")).toBeEnabled();
  });
  it("clears the code and disables controls through one verification", async () => {
    let finish!: (result: { status: string }) => void;
    mocks.verify.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<AdminMfa mode="challenge" next="/admin" />);
    submit(); submit();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("6桁のコード")).toBeDisabled();
    expect(screen.getByRole("button")).toBeDisabled();
    expect(container.querySelector("form")).toHaveAttribute("aria-busy", "true");
    await act(async () => finish({ status: "invalid_code" }));
    expect(screen.getByRole("button")).toBeEnabled();
  });
  it.each(["challenge", "enroll"] as const)("contains transport failures in %s mode", async (mode) => {
    mocks.enroll.mockRejectedValue(new Error("private detail"));
    mocks.verify.mockRejectedValue(new Error("private detail"));
    render(<AdminMfa mode={mode} next="/admin" />);
    if (mode === "challenge") submit(); else fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("現在確認できません。時間をおいて再度お試しください。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private detail");
  });
  it("navigates fully only to the server-supplied next after ok, ignoring the current URL", async () => {
    render(<AdminMfa mode="challenge" next="/admin/verifications?filter=submitted" />);
    const realWindow = window;
    vi.stubGlobal("window", new Proxy(realWindow, { get(target, property) {
      if (property === "location") return { assign: mocks.assign, search: "?next=https://evil.invalid" };
      return Reflect.get(target, property);
    } }));
    mocks.verify.mockResolvedValue({ status: "ok", next: "https://evil.invalid" });
    submit();
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledExactlyOnceWith("/admin/verifications?filter=submitted"));
  });
});
