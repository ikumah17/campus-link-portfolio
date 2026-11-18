# Auth email templates (MAIL-001)

Japanese templates for Supabase Auth emails. They are **not applied** yet: the hosted project keeps Supabase's default
email and default templates until custom SMTP exists (DECIDE-001, docs/36).

| File | Supabase template | Subject | Link type |
|---|---|---|---|
| `confirm-signup.html` | Confirm signup | 【Campus Link】メールアドレスの確認 | `type=signup` |
| `magic-link.html` | Magic Link | 【Campus Link】ログイン用リンク | `type=email` |

The subject of each template is also in the comment at the top of its file.

- Every link goes to the app's own `/auth/confirm` route with `token_hash` and `type`, which verifies the token and
  checks the account before any session reaches the app. No template uses `{{ .ConfirmationURL }}`, which would go
  through Supabase's verify endpoint and skip those checks.
- The app has only the sign-up confirmation flow. It never calls `signInWithOtp`, so the magic-link template matters
  only for a magic link sent from the dashboard or the admin API; `/auth/confirm` accepts its `type=email`.
- There is no password-reset, email-change, invite or reauthentication template: the app has none of those flows, and
  `/auth/confirm` rejects their types.

## Applying them (later, coordinator only)

Applying a template is a **hosted change**: only the coordinator does it, after custom SMTP is configured, and records
it in docs/05.

1. Make sure the project's **Site URL** (Authentication > URL Configuration) is the deployed app's URL, such as
   `https://<app-domain>`, with no path and no trailing slash. `{{ .SiteURL }}` in the links is that value; a wrong
   Site URL sends every link to the wrong place.
2. In Authentication > Emails > Templates, open **Confirm signup**, set the subject from the table, and paste the
   body of `confirm-signup.html`.
3. Do the same for **Magic Link** with `magic-link.html`.
4. Send a test sign-up and check that the link opens `<Site URL>/auth/confirm?token_hash=...&type=signup`.
