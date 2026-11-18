import { describe, expect, it } from "vitest";
import { submit, withdraw, claim, release, decide, demoSubject, type VerificationState, type VerificationStatus } from "@/lib/verification-demo";

const reviewer = "reviewer";
const submitted = () => submit([], "age", ["synthetic:sample-1"]).state;
const claimed = () => claim(submitted(), "demo-submission-1", reviewer).state;
const id = "demo-submission-1";
describe("pure verification contract demo", () => {
  it.each(["age", "enrollment"])("submits %s, copies refs, and blocks unfinished duplicates", (kind) => {
    const refs = ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3"];
    const result = submit([], kind, refs); refs.pop();
    expect(result.code).toBe("ok"); expect(result.state[0]).toMatchObject({ kind, status: "submitted", version: 1, reviewerId: null }); expect(result.state[0].refs).toHaveLength(3);
    expect(submit(result.state, kind, ["synthetic:sample-1"]).code).toBe("invalid_state");
    const inReview = claim(result.state, id, reviewer).state;
    expect(submit(inReview, kind, ["synthetic:sample-1"]).code).toBe("invalid_state");
    expect(submit(withdraw(result.state, id).state, kind, ["synthetic:sample-1"]).code).toBe("ok");
  });
  it.each([[], ["synthetic:sample-1", "synthetic:sample-2", "synthetic:sample-3", "synthetic:sample-4"], ["synthetic:sample-1", "synthetic:sample-1"], ["synthetic:sample-4"], ["../student/document"], ["synthetic:sample-1/extra"]])("rejects invalid refs %j", (...refs) => {
    // it.each spreads an array row into arguments.
    expect(submit([], "age", refs as string[]).code).toBe("validation");
  });
  it("rejects an unknown kind and allows independent kinds", () => {
    expect(submit([], "other", ["synthetic:sample-1"]).code).toBe("validation");
    expect(submit(submitted(), "enrollment", ["synthetic:sample-1"]).code).toBe("ok");
  });
  it("withdraws only own submitted items and preserves inputs", () => {
    const before = submitted(); const snapshot = JSON.stringify(before);
    const result = withdraw(before, id); expect(result.state[0]).toMatchObject({ status: "withdrawn", version: 2 });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(withdraw([{ ...before[0], subjectId: "other" }], id).code).toBe("not_available");
  });
  it("claims, releases and reclaims with version increments", () => {
    const active = claimed(); expect(active[0]).toMatchObject({ status: "in_review", reviewerId: reviewer, version: 2 });
    const released = release(active, id, reviewer); expect(released.state[0]).toMatchObject({ status: "submitted", reviewerId: null, version: 3 });
    expect(claim(released.state, id, reviewer).state[0].version).toBe(4);
    expect(claim(submitted(), id, demoSubject.subjectId).code).toBe("invalid_state");
    expect(claim(submitted(), id, "").code).toBe("invalid_state");
    expect(release(active, id, "other").code).toBe("invalid_state");
  });
  it.each([true, false])("decides approve=%s with metadata", (approve) => {
    const result = decide(claimed(), id, reviewer, approve, "架空の理由", 2);
    expect(result.code).toBe("ok"); expect(result.state[0]).toMatchObject({ status: approve ? "approved" : "rejected", version: 3, reason: approve ? null : "架空の理由" });
    expect(result.state[0].decidedAt).toBeTruthy();
    expect(submit(result.state, "age", ["synthetic:sample-1"]).code).toBe("ok");
  });
  it.each([0, 1, 200, 201])("counts %i Unicode code points for rejection", (length) => {
    expect(decide(claimed(), id, reviewer, false, "学".repeat(length - Math.min(length, 1)) + (length ? "𠮷" : ""), 2).code).toBe(length >= 1 && length <= 200 ? "ok" : "validation");
  });
  it("rejects whitespace-only reasons, wrong reviewers and stale versions", () => {
    expect(decide(claimed(), id, reviewer, false, "  ", 2).code).toBe("validation");
    expect(decide(claimed(), id, "other", true, "", 2).code).toBe("invalid_state");
    expect(decide(claimed(), id, reviewer, true, "", 1).code).toBe("invalid_state");
  });
  it.each(["submitted", "in_review", "approved", "rejected", "withdrawn"] as VerificationStatus[])("guards operations from %s", (status) => {
    const state: VerificationState = [{ ...claimed()[0], status }];
    if (status !== "submitted") { expect(withdraw(state, id).code).toBe("invalid_state"); expect(claim(state, id, reviewer).code).toBe("invalid_state"); }
    if (status !== "in_review") { expect(release(state, id, reviewer).code).toBe("invalid_state"); expect(decide(state, id, reviewer, true, "", 2).code).toBe("invalid_state"); }
  });
  it("returns not_available for every operation on an unknown ID", () => {
    for (const result of [withdraw([], id), claim([], id, reviewer), release([], id, reviewer), decide([], id, reviewer, true, "", 1)]) { expect(result.code).toBe("not_available"); expect(result.state).toEqual([]); }
  });
});
