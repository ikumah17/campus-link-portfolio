import { demoAffiliations } from "@/data/demo-affiliations";
import { demoProfiles } from "@/data/demo-profiles";
import type { Submission } from "@/lib/verification-demo";

export const demoReviewer = "demo-reviewer";
// These are fictional samples, unrelated to submissions on /verification.
export function createDemoSubmissions(): Submission[] {
  const school = demoAffiliations[0];
  const affiliation = [school.name, school.departments[0].name, school.departments[0].classes[0].name].join(" / ");
  return (["submitted", "in_review", "approved", "rejected"] as const).map((status, i) => ({
    id: `review-sample-${i + 1}`, subjectId: demoProfiles[i % demoProfiles.length].id,
    displayName: `${demoProfiles[i % demoProfiles.length].name}（架空）`, birthDate: "2000-02-29", affiliation,
    kind: i % 2 === 0 ? "age" : "enrollment", refs: [`synthetic:sample-${i % 3 + 1}`],
    status, version: status === "submitted" ? 1 : status === "in_review" ? 2 : 3,
    reviewerId: status === "submitted" ? null : demoReviewer,
    decidedAt: status === "approved" || status === "rejected" ? "2026-10-30T00:00:00.000Z" : null,
    reason: status === "rejected" ? "架空サンプルの再選択が必要です（デモ）。" : null,
  }));
}
