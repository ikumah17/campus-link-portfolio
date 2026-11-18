// FIX-002: /login?error=signout says that the other devices' sign-out could not be confirmed.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMessages } from "@/lib/auth-validation";

const mocks = vi.hoisted(() => ({ mode: vi.fn() }));
vi.mock("@/lib/backend", () => ({ backendMode: mocks.mode }));
vi.mock("@/server/auth-actions", () => ({ signUpAction: vi.fn(), signInAction: vi.fn() }));
import LoginPage from "@/app/login/page";

beforeEach(() => { vi.resetAllMocks(); mocks.mode.mockReturnValue("supabase"); });
async function page(error?: string | string[]) {
  render(await LoginPage({ searchParams: Promise.resolve(error === undefined ? {} : { error }) }));
}

describe("login page notices", () => {
  it("announces an unconfirmed global sign-out", async () => {
    await page("signout");
    expect(screen.getByRole("alert")).toHaveTextContent(authMessages.signoutError);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });
  it("keeps the confirmation notice for error=confirm", async () => {
    await page("confirm");
    expect(screen.getByRole("alert")).toHaveTextContent(authMessages.confirmError);
    expect(screen.queryByText(authMessages.signoutError)).not.toBeInTheDocument();
  });
  it.each([[undefined], ["other"], ["SIGNOUT"], [["signout", "signout"]]])("shows no notice for %j", async (error) => {
    await page(error);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(authMessages.signoutError)).not.toBeInTheDocument();
  });
});
