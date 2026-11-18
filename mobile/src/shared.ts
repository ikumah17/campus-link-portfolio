// MOBILE-001/002 (docs/42 §1.1): the only web files the app imports. Each has no import of its own, so nothing from
// next, react-dom or server-only can enter the bundle; tests/shared.test.ts checks that.
export { authFieldMessages, authMessages, passwordFieldMessages, passwordHint, passwordMessages, validateAuthInput } from "../../src/lib/auth-validation";
export type { AuthFieldErrors, AuthFormState, AuthStatus } from "../../src/lib/auth-validation";
export {
  codePointLength, PURPOSE_LABELS, PURPOSES, purposeText, sortPurposes, validateBio, validateBirthDate, validateDisplayName, validateGender, validatePurposes,
} from "../../src/lib/onboarding-rules";
export type { Purpose } from "../../src/lib/onboarding-rules";
export { reasonLabel } from "../../src/lib/verification-reasons";
// Only the constants and the size rule: the web's shrinking uses a browser canvas, so src/photos.ts shrinks natively.
export { DOWNSCALE_MAX_EDGE, DOWNSCALE_QUALITY, MAX_PHOTO_BYTES, targetSize } from "../../src/lib/photo-downscale";
// MOBILE-003: the chat body rule (1–2000 characters, not only spaces) and the report reasons with their labels.
export { validateBody } from "../../src/lib/chat-gateway";
export { reportReasons } from "../../src/lib/safety-gateway";
export type { ReportReason } from "../../src/lib/safety-gateway";
