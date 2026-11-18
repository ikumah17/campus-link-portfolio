import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DemoDisclaimer, demoDisclaimer } from "@/components/demo-disclaimer";

afterEach(() => vi.unstubAllEnvs());

it("shows the personal-project disclaimer in demo mode as plain text", () => {
  vi.stubEnv("CAMPUS_LINK_BACKEND", "");
  const { container } = render(<DemoDisclaimer />);
  const note = screen.getByText(demoDisclaimer);
  expect(note.tagName).toBe("P");
  expect(note).not.toHaveAttribute("role");
  expect(note).not.toHaveAttribute("tabindex");
  expect(container.querySelectorAll("a, button, header, footer, nav, aside, section, main")).toHaveLength(0);
  expect(demoDisclaimer).toContain("架空のデータ");
});

it("renders nothing when the hosted backend is configured", () => {
  vi.stubEnv("CAMPUS_LINK_BACKEND", "supabase");
  const { container } = render(<DemoDisclaimer />);
  expect(container).toBeEmptyDOMElement();
});
