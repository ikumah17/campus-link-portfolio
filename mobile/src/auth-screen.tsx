import { Link, Redirect, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, type TextInputInstance } from "react-native";
import { useAuth, type AuthResult } from "./auth-context";
import { authMessages, passwordHint, validateAuthInput } from "./shared";
import { ui } from "./theme";
import { openWebPage } from "./ui";

// MOBILE-001: the app's sign-in and sign-up, the same form and messages as the web's src/components/auth-form.tsx.
// The email confirmation link opens on the web (docs/42 §3.2 A); the user then signs in here.
export function AuthScreen({ kind }: { kind: "signin" | "signup" }) {
  const signup = kind === "signup";
  const { signedIn, services, signIn, signUp } = useAuth();
  // MOBILE-004: the web's /login?error=signout (FIX-002 N-4) after a sign-out everywhere that Auth did not confirm.
  const signoutError = useLocalSearchParams<{ error?: string }>().error === "signout" && !signup;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordShown, setPasswordShown] = useState(false);
  const [result, setResult] = useState<AuthResult | null>(services ? null : { status: "unavailable" });
  const [pending, setPending] = useState(false);
  const emailRef = useRef<TextInputInstance>(null);
  const passwordRef = useRef<TextInputInstance>(null);

  if (signedIn) return <Redirect href="/home" />;

  async function submit() {
    if (pending) return;
    const input = validateAuthInput(email, password, signup ? "signup" : "signin");
    // The password is not kept in state once submitted, as on the web.
    setPassword("");
    if (!input.valid) {
      setResult({ status: "invalid", fieldErrors: input.fieldErrors });
      (input.fieldErrors.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setPending(true);
    setResult(null);
    try {
      setResult(await (signup ? signUp : signIn)(input.email, input.password));
    } finally {
      setPending(false);
    }
  }

  const errors = result?.fieldErrors ?? {};
  const message = result && result.status !== "ok" ? authMessages[result.status] : "";
  const title = signup ? "新規登録" : "ログイン";

  return <ScrollView contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled">
    <Text style={ui.brand}>Campus Link</Text>
    <Text style={ui.title} accessibilityRole="header">{title}</Text>
    <Text style={ui.note}>18歳以上の対象校の学生のみ</Text>
    {signoutError ? <Text testID="auth-signout-error" style={[ui.message, { marginTop: 16 }]} accessibilityRole="alert">{authMessages.signoutError}</Text> : null}
    <View style={ui.form}>
      <View>
        <Text style={ui.label}>メールアドレス</Text>
        <TextInput ref={emailRef} testID="auth-email" style={ui.input} value={email} onChangeText={setEmail}
          accessibilityLabel="メールアドレス" autoCapitalize="none" autoCorrect={false} autoComplete="email"
          keyboardType="email-address" textContentType="username" editable={!pending} />
        {errors.email ? <Text style={ui.error}>{errors.email}</Text> : null}
      </View>
      <View>
        <Text style={ui.label}>パスワード</Text>
        <TextInput ref={passwordRef} testID="auth-password" style={ui.input} value={password} onChangeText={setPassword}
          accessibilityLabel="パスワード" secureTextEntry={!passwordShown} autoCapitalize="none" autoCorrect={false}
          autoComplete={signup ? "new-password" : "current-password"} textContentType={signup ? "newPassword" : "password"}
          editable={!pending} onSubmitEditing={() => void submit()} />
        <PasswordToggle shown={passwordShown} onToggle={() => setPasswordShown((shown) => !shown)} />
        {signup ? <Text testID="auth-password-hint" style={ui.hint}>{passwordHint}</Text> : null}
        {errors.password ? <Text style={ui.error}>{errors.password}</Text> : null}
      </View>
      <Pressable testID="auth-submit" accessibilityRole="button" accessibilityState={{ disabled: pending, busy: pending }}
        disabled={pending} onPress={() => void submit()} style={[ui.primaryButton, pending && ui.disabled]}>
        <Text style={ui.primaryButtonText}>{title}</Text>
      </Pressable>
      {message ? <Text testID="auth-message" style={ui.message} accessibilityRole={result?.status === "sent" ? "text" : "alert"}
        accessibilityLiveRegion="polite">{message}</Text> : null}
    </View>
    {signup && services ? <Text style={ui.consent}>
      登録すると、<Text style={ui.textLinkText} accessibilityRole="link" onPress={() => openWebPage(services.termsUrl)}>利用規約</Text>と<Text
        style={ui.textLinkText} accessibilityRole="link" onPress={() => openWebPage(services.privacyUrl)}>プライバシーポリシー</Text>に同意したものとみなします。
    </Text> : null}
    <View style={ui.links}>
      <Link href={signup ? "/sign-in" : "/sign-up"} replace style={ui.textLink}>
        <Text style={ui.textLinkText}>{signup ? "ログイン" : "新規登録"}</Text>
      </Link>
      <Link href="/" dismissTo style={ui.textLink}>
        <Text style={ui.textLinkText}>ウェルカムへ戻る</Text>
      </Link>
    </View>
  </ScrollView>;
}

// FIX-006: the password is hidden by default; this text button shows or hides it and never changes the value.
function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return <Pressable testID="auth-password-toggle" accessibilityRole="button" accessibilityLabel={shown ? "パスワードを隠す" : "パスワードを表示"}
    onPress={onToggle} style={[ui.textLink, { alignSelf: "flex-end" }]}>
    <Text style={ui.textLinkText}>{shown ? "隠す" : "表示"}</Text>
  </Pressable>;
}
