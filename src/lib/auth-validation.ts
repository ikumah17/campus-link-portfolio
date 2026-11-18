export type AuthStatus = "idle" | "sent" | "failed" | "rate_limited" | "unavailable" | "invalid";
export type AuthFieldErrors = { email?: string; password?: string };
export type AuthFormState = { status: AuthStatus; fieldErrors?: AuthFieldErrors };

export const authMessages = {
  idle: "",
  sent: "確認メールを送信しました。メールのリンクから登録を完了してください。届かない場合は、入力内容を確認し、時間をおいて再度お試しください。",
  failed: "ログインできませんでした。メールアドレスとパスワード、または確認メールの手続きをご確認ください。",
  rate_limited: "しばらくしてから再度お試しください。",
  unavailable: "現在ご利用いただけません。時間をおいて再度お試しください。",
  invalid: "入力内容を確認してください。",
  confirmError: "確認リンクが無効か期限切れです。もう一度お試しください。",
  signoutError: "ほかの端末のログアウトを確かめられませんでした。ログインして、もう一度「すべての端末からログアウト」を押してください。",
} as const;

// FIX-005: the sign-in field messages. Sign-in keeps its earlier checks (8–72 characters, at most 72 bytes, the Auth
// limit), so an account made under an older rule can still sign in.
export const authFieldMessages = {
  email: "メールアドレスの形式を確認してください。",
  password: "パスワードは8〜72文字で入力してください。",
  passwordTooLong: "パスワードが長すぎます。",
} as const;

// FIX-005: the sign-up rule, shared by the web form, the app and POST /api/mobile/auth/signup: 8–72 half-width
// letters, digits and symbols (printable ASCII without spaces, so 72 characters are 72 bytes), with at least one
// lowercase letter, uppercase letter, digit and symbol. Hosted Auth enforces the same classes.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
export const passwordHint = "8〜72文字で、半角の英字の大文字・小文字・数字・記号（!や#など）をそれぞれ1つ以上入れてください。";
export const passwordMessages = {
  short: "8文字以上にしてください。",
  long: "72文字以内にしてください。",
  characters: "全角の文字や空白は使えません。半角の英字・数字・記号を使ってください。",
  lowercase: "英字の小文字を1つ以上入れてください。",
  uppercase: "英字の大文字を1つ以上入れてください。",
  digit: "数字を1つ以上入れてください。",
  symbol: "記号（!や#など）を1つ以上入れてください。",
  // Auth refused a password that passed these checks (weak_password); the hint beside the field gives the rule.
  rule: "このパスワードは使えません。別のパスワードにしてください。",
} as const;
export type PasswordProblem = keyof typeof passwordMessages;

/** The first rule a new password breaks, or null when it meets them all. */
export function newPasswordProblem(password: string): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return "short";
  if (length > PASSWORD_MAX) return "long";
  if (!/^[!-~]+$/.test(password)) return "characters";
  if (!/[a-z]/.test(password)) return "lowercase";
  if (!/[A-Z]/.test(password)) return "uppercase";
  if (!/[0-9]/.test(password)) return "digit";
  if (!/[^A-Za-z0-9]/.test(password)) return "symbol";
  return null;
}

/** Every password field message a sign-up or sign-in answer may carry; the app shows no other server text. */
export const passwordFieldMessages: readonly string[] = [...Object.values(passwordMessages), authFieldMessages.password, authFieldMessages.passwordTooLong];

export function validateAuthInput(rawEmail: unknown, rawPassword: unknown, rule: "signin" | "signup") {
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  const fieldErrors: AuthFieldErrors = {};
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = authFieldMessages.email;
  if (rule === "signup") {
    const problem = newPasswordProblem(password);
    if (problem) fieldErrors.password = passwordMessages[problem];
  } else {
    const length = [...password].length;
    if (length < PASSWORD_MIN || length > PASSWORD_MAX) fieldErrors.password = authFieldMessages.password;
    else if (new TextEncoder().encode(password).length > PASSWORD_MAX) fieldErrors.password = authFieldMessages.passwordTooLong;
  }
  return { email, password, fieldErrors, valid: Object.keys(fieldErrors).length === 0 };
}
