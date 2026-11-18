import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProfileDetail } from "@/components/profile-detail";
import { demoProfiles, getDemoProfile } from "@/data/demo-profiles";
import { purposeText } from "@/lib/onboarding-rules";

describe("demo profile data helpers", () => {
  it("finds only bundled profiles", () => {
    for (const p of demoProfiles) expect(getDemoProfile(p.id)).toBe(p);
    for (const bad of ["demo-4", "", "DEMO-1", "__proto__", "constructor", "../demo-1"]) expect(getDemoProfile(bad)).toBeUndefined();
  });
});

describe("ProfileDetail", () => {
  for (const profile of demoProfiles) {
    it(`shows ${profile.id} with one bio, its purposes and no mode`, () => {
      const { container } = render(<ProfileDetail profile={profile} />);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`${profile.name}${profile.age}`);
      expect(screen.getByText(profile.affiliation, { exact: false })).toHaveTextContent(profile.gender);
      expect(screen.getByText(profile.bio)).toBeInTheDocument();
      if (profile.purposes.length) expect(screen.getByText(purposeText(profile.purposes))).toBeInTheDocument();
      else expect(screen.queryByText("目的")).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(/モード|恋愛|申請|利用目的/);
      const hobbies = within(screen.getByRole("list", { name: "趣味" })).getAllByRole("listitem");
      expect(hobbies.map((li) => li.textContent)).toEqual(profile.hobbies);
      expect(screen.getByRole("img")).toHaveAttribute("src", profile.image);
      expect(screen.getByRole("img")).toHaveAccessibleName(expect.stringContaining("架空"));
      expect(screen.getByText("架空のデモプロフィール")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "一覧へ戻る" })).toHaveAttribute("href", "/");
    });
  }

  it("opens block and report dialogs while more remains unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    render(<ProfileDetail profile={demoProfiles[0]} />);
    for (const name of ["ブロック", "通報"]) {
      const trigger = screen.getByRole("button", { name });
      await user.click(trigger);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(trigger).toHaveFocus();
    }
    expect(screen.getByRole("button", { name: "その他（準備中）" })).toHaveAttribute("aria-disabled", "true");
  });

  it("does not show verification badges, department/class, emoji or external URLs", () => {
    const { container } = render(<ProfileDetail profile={demoProfiles[1]} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/認証|本人確認済|verified/i);
    expect(text).not.toMatch(/学科|クラス|学部/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
  });
});
